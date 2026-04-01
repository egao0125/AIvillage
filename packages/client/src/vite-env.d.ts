/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_TOOLS_ENABLED: string;
  readonly VITE_DEV_ADMIN_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
