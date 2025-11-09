export default async function stubProvider(filePath, opts={}) {
  const base = 100 + (filePath.length % 50) * 10;
  const label = ["Driveway wash","2-car epoxy floor","Roof wash","Lawn mow"][filePath.length % 4];
  const aiLow = Math.round(base * 0.9);
  const aiHigh = Math.round(base * 1.2);
  const notes = "Informational estimate based on visual cues; excludes hidden damage.";
  return { label, aiLow, aiHigh, notes, confidencePct: 80 };
}
