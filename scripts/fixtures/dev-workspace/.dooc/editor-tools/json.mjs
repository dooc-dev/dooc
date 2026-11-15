import { readFileSync } from "node:fs";

const formatting = process.argv[2] === "format";
try {
    const value = JSON.parse(readFileSync(0, "utf8"));
    if (formatting) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else
        process.stdout.write(
            JSON.stringify(
                value?.debug === true
                    ? [
                          {
                              message: "Demo check: turn debug off before publishing.",
                              severity: "warning",
                              line: 1,
                              column: 1,
                          },
                      ]
                    : [],
            ),
        );
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (formatting) process.stderr.write(`${message}\n`);
    else process.stdout.write(JSON.stringify([{ message, severity: "error", line: 1, column: 1 }]));
    process.exitCode = 1;
}
