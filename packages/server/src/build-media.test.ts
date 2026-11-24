import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compressMedia } from "./build-media.js";

const roots: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
let ffmpeg = false;
try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    ffmpeg = true;
} catch {
    /* Codec integration checks need the optional system tools. */
}

it("keeps unsupported formats and missing-codec inputs intact with actionable warnings", async () => {
    const data = Buffer.from("unchanged source");
    expect(await compressMedia(data, "image/gif")).toEqual({
        data,
        mime: "image/gif",
        warning: expect.stringContaining("No preview compressor"),
    });
    vi.stubEnv("PATH", "");
    const result = await compressMedia(data, "video/mp4");
    expect(result.data).toEqual(data);
    expect(result.mime).toBe("video/mp4");
    expect(result.warning).toContain("Install FFmpeg");
});

it.skipIf(!ffmpeg)(
    "encodes a PNG as smaller lossless WebP without changing the source",
    async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-codec-image-"));
        roots.push(root);
        const input = join(root, "input.png");
        execFileSync("ffmpeg", [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=512x512",
            "-frames:v",
            "1",
            "-threads",
            "1",
            input,
        ]);
        const data = readFileSync(input);
        const result = await compressMedia(data, "image/png");
        expect(result.warning).toBeUndefined();
        expect(result.mime).toBe("image/webp");
        expect(result.data.length).toBeLessThan(data.length);
        expect(readFileSync(input)).toEqual(data);
        const output = join(root, "output.webp");
        writeFileSync(output, result.data);
        const pixels = (file: string) =>
            execFileSync(
                "ffmpeg",
                [
                    "-v",
                    "error",
                    "-i",
                    file,
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgba",
                    "-threads",
                    "1",
                    "pipe:1",
                ],
                { maxBuffer: 2 * 1024 * 1024 },
            );
        expect(pixels(output)).toEqual(pixels(input));
    },
);

it.skipIf(!ffmpeg)(
    "converts a non-browser MP4 codec to H.264 without dropping the video",
    async () => {
        const root = mkdtempSync(join(tmpdir(), "dooc-codec-video-"));
        roots.push(root);
        const input = join(root, "input.mp4");
        execFileSync("ffmpeg", [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64:r=2",
            "-t",
            "1",
            "-c:v",
            "mpeg4",
            "-threads",
            "1",
            input,
        ]);
        const data = readFileSync(input);
        const result = await compressMedia(data, "video/mp4");
        expect(result.warning).toBeUndefined();
        expect(readFileSync(input)).toEqual(data);
        const output = join(root, "output.mp4");
        writeFileSync(output, result.data);
        const probe = JSON.parse(
            execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], {
                encoding: "utf8",
            }),
        );
        expect(probe.streams).toMatchObject([
            { codec_type: "video", codec_name: "h264", width: 64, height: 64, nb_frames: "2" },
        ]);
    },
);
