import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import "./styles.css";
import { applySavedTheme } from "./theme.js";
import { startAnalytics } from "./analytics.js";

applySavedTheme();
startAnalytics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
