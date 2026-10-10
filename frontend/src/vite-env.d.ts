/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the lakehouse API. Defaults to `http://127.0.0.1:8000`. */
  readonly VITE_API_BASE_URL?: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
