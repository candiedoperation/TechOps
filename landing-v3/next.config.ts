import { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const basePath = isProd
  ? ""
  : ""; /* atheesh@ didn't wanna break variables and stuff. Prod isn't served at /adc-website! */

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  basePath: basePath,
  assetPrefix: basePath,
  trailingSlash: true,

  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
