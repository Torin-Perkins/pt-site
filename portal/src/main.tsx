import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "./auth";
import { ToastProvider } from "./components/ui";
import App from "./App";
import "./styles.css";

// Arrived via the site's 404 page (/portal/?route=/billing?checkout=success):
// restore the address that was asked for before the router reads it.
const route = new URLSearchParams(window.location.search).get("route");
if (route && route.startsWith("/") && !route.startsWith("//")) {
  window.history.replaceState(null, "", import.meta.env.BASE_URL.replace(/\/$/, "") + route);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
