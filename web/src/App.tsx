import { useEffect, useState } from "react";

export function App() {
  const [api, setApi] = useState<"checking" | "ok" | "down">("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => setApi(r.ok ? "ok" : "down"))
      .catch(() => setApi("down"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Release Brief Assistant</h1>
      <p>API status: {api}</p>
    </main>
  );
}
