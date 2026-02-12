import dotenv from "dotenv";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import { disconnect } from "mongoose";
import Player from "../../models/player.model.js";
import connectDB from "../../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "../../.env") });

const importPlayers = async () => {
  try {
    await connectDB();

    const results = [];
    const filePath = join(__dirname, "data", "player.csv");

    createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        console.log("Raw data:", data);

        const playerTPId                                          = Number  (data.playerTPId                                         ?.trim());
        const playerName                                          =         (data.playerName                                         ?.trim());
        const countryTPId                                         = Number  (data.countryTPId                                        ?.trim());
        const playerBirthDate                                     = new Date(data.playerBirthDate                                    ?.trim());
        const playerHeight                                        = Number  (data.playerHeight                                       ?.trim());
        const playerWeight                                        = Number  (data.playerWeight                                       ?.trim());
        const playerTurnedPro                                     = Number  (data.playerTurnedPro                                    ?.trim());
        const playsId                                             = Number  (data.playsId                                            ?.trim());

        console.log(`Parsed values - ID: ${playerTPId}, Player: ${playerName}`);
        console.log("Raw data:", JSON.stringify(data));

        if (!isNaN(playerTPId) && playerName) {
          results.push({ 
            _id                                                : playerTPId,
            playerName                                         : playerName,
            countryTPId                                        : isNaN(countryTPId)                                         ? undefined : countryTPId,
            playerBirthDate                                    : isNaN(playerBirthDate)                                     ? undefined : playerBirthDate,
            playerHeight                                       : isNaN(playerHeight)                                        ? undefined : playerHeight,
            playerWeight                                       : isNaN(playerWeight)                                        ? undefined : playerWeight,
            playerTurnedPro                                    : isNaN(playerTurnedPro)                                     ? undefined : playerTurnedPro,
            playsId                                            : isNaN(playsId)                                             ? undefined : playsId,
          });
        } else {
          console.warn(`No valid data (ID: ${playerTPId}, ${playerName})`);
        }
      })
      .on("end", async () => {
        try {
          await Player.deleteMany({});
          await Player.insertMany(results);
          console.log("✅ Players imported successfully!");
        } catch (err) {
          console.error("❌ Error during DB insert:", err.message);
        } finally {
          disconnect();
        }
      });

    // 👉 process.on:
    process.on("exit", () => {
      console.log("Process exiting. Final IDs collected:", results.map(r => r._id));
      const undefinedFields = results.filter(r => 
        r.playerTPId === undefined || 
        r.playerName === undefined
      );
      if (undefinedFields.length > 0) {
        //console.log("⚠️ Entries with missing required fields:", undefinedFields);
      }
    });

  } catch (err) {
    console.error("❌ Error importing players:", err);
    disconnect();
  }
};

importPlayers();