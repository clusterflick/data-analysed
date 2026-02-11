const path = require("node:path");
const fs = require("node:fs");
const mapshaper = require("mapshaper");
const slugify = require("slugify");

const dataDir = path.resolve(__dirname, "../data");
const originalDataDir = path.join(dataDir, "original-map-data");

async function convertGLABoundary() {
  const inputDir = path.join(originalDataDir, "gla 2");
  const inputFile = path.join(inputDir, "London_GLA_Boundary.shp");
  const outputFile = path.join(dataDir, "London_GLA_Boundary.geojson");

  console.log("Converting GLA boundary...");
  await mapshaper.runCommands(
    `-i "${inputFile}" -proj wgs84 -o "${outputFile}" format=geojson`,
  );
  console.log(`  -> ${outputFile}`);
}

async function convertBoroughBoundaries() {
  const inputDir = path.join(originalDataDir, "msoa2021");
  const outputDir = path.join(dataDir, "boroughs");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const shapefiles = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".shp"));

  console.log(`Converting ${shapefiles.length} borough boundaries...`);

  for (const shapefile of shapefiles) {
    const boroughName = shapefile.replace(".shp", "");
    const inputFile = path.join(inputDir, shapefile);
    const outputFile = path.join(
      outputDir,
      `${slugify(boroughName.toLowerCase().trim())}.geojson`,
    );

    await mapshaper.runCommands(
      `-i "${inputFile}" -proj wgs84 -o "${outputFile}" format=geojson`,
    );
    console.log(`  -> ${boroughName}`);
  }
}

async function main() {
  await convertGLABoundary();
  await convertBoroughBoundaries();
  console.log("Done!");
}

main();
