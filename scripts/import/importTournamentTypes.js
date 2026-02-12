import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import TournamentType from "../../models/tournamentType.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importTournamentTypes = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "tournamentType.csv");

    createReadStream(filePath)
    .pipe(csv())
    .on("data", (data) => {
      // Log the raw data object to see its exact structure
      console.log("Raw data:", data);
      
      // Try accessing by both direct property and using bracket notation
      const id = Number(data.TournamentTypeId || data['tournamentTypeId']);
      const tournamentType = (data.TournamentType || data['tournamentType'])?.trim();
      
      console.log(`Parsed values - ID: ${id}, TournamentType: ${tournamentType}`);
      
      if (!isNaN(id) && tournamentType) {
        results.push({ 
          _id: id, 
          tournamentType: tournamentType
        });
        console.log(`Added entry: _id=${id}, TournamentType=${tournamentType}`);
      } else {
        console.warn(`No valid data (ID: ${id}, ${tournamentType})`);
      }
    })
      .on("end", async () => {
        try {
          await TournamentType.deleteMany({});
          await TournamentType.insertMany(results);
          console.log("✅ TournamentTypes imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });
  } catch (err) {
    console.error("❌ Error importing tournamentTypes:", err);
    disconnect();
  }
};

importTournamentTypes();