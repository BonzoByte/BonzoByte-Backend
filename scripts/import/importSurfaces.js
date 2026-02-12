import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import Surface from "../../models/surface.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importSurfaces = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "surface.csv");

    createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => {
      // Log the raw data object to see its exact structure
      console.log("Raw data:", data);
      
      // Try accessing by both direct property and using bracket notation
      const id = Number(data.surfaceId || data['surfaceId']);
      const surface = (data.surface || data['surface'])?.trim();
      
      console.log(`Parsed values - ID: ${id}, Surface: ${surface}`);
      
      if (!isNaN(id) && surface) {
        results.push({ 
          _id: id, 
          surface: surface
        });
        console.log(`Added entry: _id=${id}, Surface=${surface}`);
      } else {
        console.warn(`No valid data (ID: ${id}, ${surface})`);
      }
    })
      .on("end", async () => {
        try {
          console.log(results);
          await Surface.deleteMany({});
          await Surface.insertMany(results);
          console.log("✅ Surfaces imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });
  } catch (err) {
    console.error("❌ Error importing surfaces:", err);
    disconnect();
  }
};

importSurfaces();