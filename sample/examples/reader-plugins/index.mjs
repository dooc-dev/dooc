import { createSampleMock } from "./mock.mjs";
import { createSamplePlugin } from "./sample.mjs";

const keys = ["DOOC_SAMPLE_AUTHORIZATION_URL", "DOOC_SAMPLE_TOKEN_URL", "DOOC_SAMPLE_USER_URL", "DOOC_SAMPLE_CLIENT_ID"];
const configured = keys.some((key) => process.env[key]);
if (configured && keys.some((key) => !process.env[key])) {
    throw new Error(`Set all sample OAuth settings: ${keys.join(", ")}`);
}
const mock = createSampleMock({ autoConnect: true });
const authMock = createSampleMock({ id: "sample-auth", origin: "https://auth.sample.dooc.invalid" });
const authPlugin = createSamplePlugin({
    id: "sample-auth", authorizationUrl: `${authMock.origin}/authorize`,
    tokenUrl: `${authMock.origin}/token`, userUrl: `${authMock.origin}/me`, clientId: "dooc-sample",
});
authPlugin.name = "Sample plugin (sign-in demo)";

export default {
    allowedDomains: [],
    plugins: [createSamplePlugin(configured ? {
        authorizationUrl: process.env.DOOC_SAMPLE_AUTHORIZATION_URL,
        tokenUrl: process.env.DOOC_SAMPLE_TOKEN_URL,
        userUrl: process.env.DOOC_SAMPLE_USER_URL,
        clientId: process.env.DOOC_SAMPLE_CLIENT_ID,
        clientSecret: process.env.DOOC_SAMPLE_CLIENT_SECRET,
    } : {
        authorizationUrl: `${mock.origin}/authorize`,
        tokenUrl: `${mock.origin}/token`,
        userUrl: `${mock.origin}/me`,
        clientId: "dooc-sample",
    }), authPlugin],
    mocks: { ...(configured ? {} : { sample: mock }), "sample-auth": authMock },
};
