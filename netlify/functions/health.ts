import { Handler } from "@netlify/functions";

const handler: Handler = async () => {
  const body = { ok: true, ts: new Date().toISOString() };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
};

export { handler };
