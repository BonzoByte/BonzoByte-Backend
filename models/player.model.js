import { Schema, model } from "mongoose";

const playerSchema = new Schema({
  _id: { type: Number, required: true }, //TPID
  playerName: { type: String, required: true},
  countryTPId: { type: Number, ref: "Country", required: false },
  playerBirthDate: { type: Date, required: false },
  playerHeight: { type: Number, required: false },
  playerWeight: { type: Number, required: false },
  playerTurnedPro: { type: Number, required: false },
  playsId: { type: Number, ref: "Plays", required: false },

});

export default model("Player", playerSchema);