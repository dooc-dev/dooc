export type Args = Record<string, unknown>;

export interface Property {
    type: string | string[];
    description?: string;
    enum?: readonly string[];
    items?: Property;
    minimum?: number;
}

export interface Tool {
    description: string;
    props: Record<string, Property>;
    required?: string[];
    run: (a: Args) => unknown;
}

export const MCP_HTTP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

const record = (value: unknown): value is Args =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const validateProperty = (name: string, value: unknown, schema: Property): void => {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
        !types.some((t) => (t === "integer" ? Number.isSafeInteger(value) : t === type)) ||
        (schema.enum && !schema.enum.includes(value as string)) ||
        (schema.minimum !== undefined && Number(value) < schema.minimum)
    )
        throw new Error(`Invalid argument: ${name}`);
    if (schema.items && Array.isArray(value))
        for (const item of value) validateProperty(name, item, schema.items);
};

export const callMcpTool = (
    tools: Record<string, Tool>,
    name: unknown,
    args: unknown = {},
): unknown => {
    if (typeof name !== "string" || !Object.hasOwn(tools, name)) throw new Error("Unknown tool");
    const tool = tools[name];
    if (!tool) throw new Error("Unknown tool");
    if (!record(args)) throw new Error("Tool arguments must be an object");
    for (const name of tool.required ?? [])
        if (!Object.hasOwn(args, name)) throw new Error(`Missing argument: ${name}`);
    for (const [name, value] of Object.entries(args)) {
        if (!Object.hasOwn(tool.props, name)) throw new Error(`Unknown argument: ${name}`);
        const schema = tool.props[name];
        if (schema) validateProperty(name, value, schema);
    }
    return tool.run(args);
};

/** One request → response (undefined for notifications). */
export const handleRpc = async (
    tools: Record<string, Tool>,
    msg: unknown,
    versions = ["2024-11-05", ...MCP_HTTP_VERSIONS],
): Promise<object | undefined> => {
    const error = (code: number, message: string) => ({
        jsonrpc: "2.0",
        id:
            record(msg) && (typeof msg.id === "string" || typeof msg.id === "number")
                ? msg.id
                : null,
        error: { code, message },
    });
    if (
        !record(msg) ||
        msg.jsonrpc !== "2.0" ||
        typeof msg.method !== "string" ||
        (msg.id !== undefined && typeof msg.id !== "string" && typeof msg.id !== "number")
    )
        return error(-32600, "invalid request");
    if (msg.id === undefined) {
        return undefined;
    }
    if (msg.params !== undefined && !record(msg.params)) return error(-32602, "invalid params");
    const params = (msg.params ?? {}) as Args;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
        case "initialize":
            return reply({
                protocolVersion: versions.includes(String(params.protocolVersion))
                    ? params.protocolVersion
                    : "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "dooc", version: "0" },
            });
        case "ping":
            return reply({});
        case "tools/list":
            return reply({
                tools: Object.entries(tools).map(([name, t]) => ({
                    name,
                    description: t.description,
                    inputSchema: {
                        type: "object",
                        properties: t.props,
                        required: t.required ?? [],
                        additionalProperties: false,
                    },
                })),
            });
        case "tools/call": {
            if (typeof params.name !== "string" || !Object.hasOwn(tools, params.name))
                return error(-32602, "unknown tool");
            let result: unknown;
            try {
                result = await callMcpTool(tools, params.name, params.arguments);
            } catch (e) {
                result = { error: e instanceof Error ? e.message : String(e) };
            }
            return reply({
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: !!result && typeof result === "object" && "error" in result,
            });
        }
        default:
            return {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: "method not found" },
            };
    }
};
