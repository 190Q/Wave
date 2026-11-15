export function assetGroups(version) {
  const linux = (debArch, arch) => [
    [`DEB`, `Wave_${version}_${debArch}.deb`],
    [`DEB slim`, `Wave_${version}_${debArch}-slim.deb`],
    [`RPM`, `Wave-${version}-1.${arch}.rpm`],
    [`RPM slim`, `Wave-${version}-1.${arch}-slim.rpm`],
    [`AppImage`, `Wave_${version}_${arch === "x86_64" ? "amd64" : "aarch64"}.AppImage`],
    [`AppImage slim`, `Wave_${version}_${arch === "x86_64" ? "amd64" : "aarch64"}-slim.AppImage`],
  ];

  return [
    ["Windows x64", [
      ["Setup", `Wave_${version}_x64-setup.exe`],
      ["Setup slim", `Wave_${version}_x64-setup-slim.exe`],
      ["MSI", `Wave_${version}_x64_en-US.msi`],
      ["MSI slim", `Wave_${version}_x64_en-US-slim.msi`],
    ]],
    ["Linux x86_64", linux("amd64", "x86_64")],
    ["Linux ARM64", linux("arm64", "aarch64")],
    ["Linux phones (Alpine / postmarketOS)", [
      ["ARM64 musl tarball", `Wave_${version}_aarch64_musl.tar.gz`],
    ]],
    ["Android", [["ARM64 APK", `Wave_${version}_arm64.apk`]]],
  ];
}

function uploadedAssets(assets) {
  return new Set(assets
    .filter((asset) => asset.size > 0 && (!asset.state || asset.state === "uploaded"))
    .map((asset) => asset.name));
}

export function missingAssets(version, assets) {
  const available = uploadedAssets(assets);
  return assetGroups(version).flatMap(([, entries]) =>
    entries.map(([, name]) => name).filter((name) => !available.has(name)),
  );
}

export function downloads(version, assets) {
  const available = assets && uploadedAssets(assets);
  const base = `https://github.com/190Q/Wave/releases/download/v${encodeURIComponent(version)}`;
  const lines = ["<!-- wave-downloads:start -->", "## Downloads", ""];
  for (const [group, entries] of assetGroups(version)) {
    const links = entries
      .filter(([, name]) => !available || available.has(name))
      .map(([label, name]) => `[${label}](${base}/${encodeURIComponent(name)})`);
    if (links.length > 0) lines.push(`- **${group}:** ${links.join(" | ")}`);
  }
  lines.push("<!-- wave-downloads:end -->");
  return lines.join("\n");
}
