export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.5 }}>
      <h1>Asana Shelf Sync</h1>
      <p>
        This service syncs an Asana task&apos;s <strong>Serial Number</strong> to a{" "}
        <strong>Storage Shelf</strong> value looked up from Google Sheets.
      </p>
      <p>
        Webhook endpoint: <code>POST /api/asana-shelf-sync</code>
        <br />
        Health check: <code>GET /api/asana-shelf-sync</code>
      </p>
    </main>
  );
}
