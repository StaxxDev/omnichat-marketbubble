/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // ws is a native-ish dep used only on the server; keep it external so Next doesn't bundle it
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push("ws");
    }
    return config;
  },
};
module.exports = nextConfig;
