const handler = async () => {
    const body = { ok: true, ts: new Date().toISOString() };
    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
};
export { handler };
//# sourceMappingURL=health.js.map