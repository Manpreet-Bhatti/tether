import { createClient } from "@tether/client";
import { ClientProvider } from "@tether/react";
import { mutators } from "@tether/tracker-shared";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// Without ?token= the tracker runs local-only. With it, it syncs as ?user=.
const q = new URLSearchParams(location.search);
const token = q.get("token");
const headers = { authorization: `Bearer ${token}` };
const sync = token && {
  push: {
    url: "/push",
    headers,
    onError: (e: Error) => console.error("tether: push stopped", e),
  },
  pull: { url: "/pull", headers: { authorization: `Bearer ${token}` } },
  poke: {
    onAuthError: (e: Error) => console.error("tether: session expired", e),
    url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/poke?token=${encodeURIComponent(token)}`,
  },
};
const client = createClient({
  mutators,
  userId: q.get("user") ?? "local",
  ...sync,
});
createRoot(document.getElementById("root")!).render(
  <ClientProvider client={client}>
    <App />
  </ClientProvider>,
);
