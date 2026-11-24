import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Optimize published previews only; source downloads retain their original bytes. */
export const compressMedia = async (
    data: Buffer,
    mime: string,
): Promise<{ data: Buffer; mime: string; warning?: string }> => {
    const original = { data, mime };
    const image = ["image/png", "image/jpeg", "image/webp"].includes(mime);
    const video = ["video/mp4", "video/webm"].includes(mime);
    if (!image && !video)
        return {
            ...original,
            warning: `No preview compressor for ${mime}; keeping original bytes`,
        };
    const directory = await mkdtemp(join(tmpdir(), "dooc-media-"));
    try {
        const input = join(directory, "input");
        const output = join(directory, video ? "output.mp4" : "output.webp");
        await writeFile(input, data);
        // Force the declared container so disguised playlists cannot read other local files.
        const demuxer = {
            "image/png": "png_pipe",
            "image/jpeg": "jpeg_pipe",
            "image/webp": "webp_pipe",
            "video/mp4": "mov",
            "video/webm": "matroska",
        }[mime];
        if (!demuxer) throw new Error(`Unsupported container: ${mime}`);
        const { stdout } = await run(
            "ffprobe",
            [
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-f",
                demuxer,
                "-show_streams",
                "-of",
                "json",
                input,
            ],
            { timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        const { streams } = JSON.parse(stdout) as {
            streams: {
                codec_type: string;
                codec_name: string;
                nb_frames?: string;
                pix_fmt?: string;
                channels?: number;
                color_transfer?: string;
            }[];
        };
        const pictures = streams.filter((stream) => stream.codec_type === "video");
        const sounds = streams.filter((stream) => stream.codec_type === "audio");
        if (
            pictures.length !== 1 ||
            sounds.length > (video ? 1 : 0) ||
            streams.length !== pictures.length + sounds.length ||
            sounds.some((stream) => (stream.channels ?? 0) > 2) ||
            pictures.some((stream) =>
                ["smpte2084", "arib-std-b67"].includes(stream.color_transfer ?? ""),
            ) ||
            (image &&
                (/10|12|16/.test(pictures[0]?.pix_fmt ?? "") ||
                    Number(pictures[0]?.nb_frames ?? 1) !== 1 ||
                    (mime === "image/png" && data.includes(Buffer.from("acTL"))) ||
                    (mime === "image/webp" && data.includes(Buffer.from("ANIM"))))) ||
            (video && /a|10|12|16/.test(pictures[0]?.pix_fmt ?? ""))
        )
            return {
                ...original,
                warning: `Unsupported animated image, high bit depth, HDR, video alpha or multiple media tracks (${mime}); keeping original bytes`,
            };
        await run(
            "ffmpeg",
            [
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-protocol_whitelist",
                "file",
                "-f",
                demuxer,
                "-i",
                input,
                "-map",
                "0:v:0",
                "-threads",
                "1",
                ...(video
                    ? [
                          "-map",
                          "0:a:0?",
                          "-c:v",
                          "libx264",
                          "-crf",
                          "23",
                          "-preset",
                          "medium",
                          "-vf",
                          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                          "-pix_fmt",
                          "yuv420p",
                          "-c:a",
                          "aac",
                          "-b:a",
                          "128k",
                          "-movflags",
                          "+faststart",
                      ]
                    : [
                          "-frames:v",
                          "1",
                          "-c:v",
                          "libwebp",
                          "-lossless",
                          mime === "image/png" ? "1" : "0",
                          "-quality",
                          "80",
                      ]),
                output,
            ],
            { timeout: 300_000, maxBuffer: 1024 * 1024 },
        );
        const compressed = await readFile(output);
        if (!compressed.length) throw new Error("Encoder produced an empty file");
        const compatible =
            image ||
            (mime === "video/mp4" &&
                pictures[0]?.codec_name === "h264" &&
                sounds.every((s) => s.codec_name === "aac")) ||
            (mime === "video/webm" &&
                ["vp8", "vp9", "av1"].includes(pictures[0]?.codec_name ?? "") &&
                sounds.every((s) => ["opus", "vorbis"].includes(s.codec_name)));
        return compressed.length < data.length || !compatible
            ? { data: compressed, mime: video ? "video/mp4" : "image/webp" }
            : original;
    } catch (error) {
        const detail =
            error instanceof Error
                ? error.message.split("\n").slice(0, 2).join(" ")
                : String(error);
        return {
            ...original,
            warning: `Could not compress ${mime}: ${detail}. Install FFmpeg with libwebp/libx264/AAC support; keeping original bytes`,
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};
