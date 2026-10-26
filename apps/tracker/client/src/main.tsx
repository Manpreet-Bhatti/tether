import { createClient } from "@tether/client";
import { ClientProvider } from "@tether/react";
import { mutators } from "@tether/tracker-shared";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const client = createClient({ mutators, userId: "local" });
createRoot(document.getElementById("root")!).render(
  <ClientProvider client={client}>
    <App />
  </ClientProvider>,
);
