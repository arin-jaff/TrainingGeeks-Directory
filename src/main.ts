import { serve } from "@hono/node-server";
import { createApp, VERSION } from "./server.ts";

const port = Number(process.env.PORT || 4000);
serve({ fetch: createApp().fetch, port });
console.log(`traininggeeks-directory v${VERSION} listening on :${port}`);
