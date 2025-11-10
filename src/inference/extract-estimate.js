const notes = {
  mow: "Standard cut, trim, and blow for typical residential turf. Adjust for slope and toys.",
  wash: "Surface wash only. Excludes sealing and heavy oil remediation.",
  junk: "Single trip. Standard load, normal access. Landfill fees included.",
  handyman: "Minor punch list. Labor only unless otherwise specified."
};

export async function extractEstimate({ lane /*, buffer */ }) {
  const bands = { mow:[45,95], wash:[75,180], junk:[95,240], handyman:[80,220] };
  const base  = bands[lane] || [50,150];
  const low   = Math.max(10, Math.round(base[0]));
  const high  = Math.max(low + 10, Math.round(base[1]));
  const note  = notes[lane] || "Range based on standard field conditions and time-on-site.";
  return { low, high, note };
}

// Named export expected by server.js
export function extractFieldsFromTranscript(input) {
  const text = typeof input === "string" ? input : (input && input.text) || "";
  const lane = (input && input.lane) || "mow";
  const base = { mow:[45,95], wash:[75,180], junk:[95,240], handyman:[80,220] }[lane] || [50,150];
  const low  = Math.max(10, Math.round(base[0]));
  const high = Math.max(low + 10, Math.round(base[1]));
  const note = text ? `From transcript: ${text.slice(0,160)}` : (notes[lane] || "Range based on standard field conditions and time-on-site.");
  return { lane, low, high, note };
}

export default extractEstimate;
