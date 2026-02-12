import { Schema, model } from "mongoose";

const tournamentEventSchema = new Schema({
  _id: { type: Number, required: true }, // koristiš TPID kao _id — super
  tournamentEventName: { type: String, required: false, minlength: 0, maxlength: 100 },
  countryTPId: { type: Number, ref: "Country", required: false },
  tournamentEventDate: { type: Date, required: true },
  tournamentLevelId: { type: Number, ref: "TournamentLevel", required: true },
  tournamentTypeId: { type: Number, ref: "TournamentType", required: true },
  prize: { type: Number },
  surfaceId: { type: Number, ref: "Surface" }
});

export default model("TournamentEvent", tournamentEventSchema);
