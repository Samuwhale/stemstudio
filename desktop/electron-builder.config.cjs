const path = require("node:path")

const projectRoot = path.resolve(__dirname, "..")

module.exports = {
  appId: "net.spithorst.stemstudio",
  productName: "StemStudio",
  copyright: "Copyright © Samuel Spithorst",
  directories: {
    output: path.join(projectRoot, "release"),
    buildResources: path.join(__dirname, "build"),
  },
  files: [
    "package.json",
    "src/**/*",
  ],
  extraResources: [
    {
      from: path.join(projectRoot, "frontend", "dist"),
      to: "frontend",
      filter: ["**/*"],
    },
    {
      from: path.join(__dirname, "runtime"),
      to: "runtime",
      filter: ["**/*"],
    },
  ],
  asar: true,
  mac: {
    category: "public.app-category.music",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    icon: path.join(__dirname, "build", "icon.icns"),
    entitlements: path.join(__dirname, "build", "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "build", "entitlements.mac.plist"),
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    title: "StemStudio ${version}",
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
}
