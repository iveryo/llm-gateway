import { RendererApi } from "../shared/types";

declare global {
  interface Window {
    gateway: RendererApi;
  }
}
