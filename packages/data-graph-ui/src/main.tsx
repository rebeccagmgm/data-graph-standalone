/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startPerformanceRecording } from "./performance-log";
const stopPerformanceRecording = startPerformanceRecording();
if (import.meta.hot) import.meta.hot.dispose(stopPerformanceRecording);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
