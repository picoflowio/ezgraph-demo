// Generates the bundled Grand Sequoia Hotel guest-folio PDF used by the
// expense graph. Dependency-free: it assembles a minimal single-page PDF with
// the standard Helvetica and Courier fonts. Rerun after changing the receipt:
//   node scripts/generate-hotel-receipt.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "graphs",
  "expense-graph",
  "data",
  "GrandSequoia.pdf",
);

const charges = [
  ["2027-05-10", "Room Charge", "189.00"],
  ["2027-05-10", "Occupancy Tax (14%)", "26.46"],
  ["2027-05-10", "Sequoia Grill - Dinner", "54.25"],
  ["2027-05-11", "Room Charge", "189.00"],
  ["2027-05-11", "Occupancy Tax (14%)", "26.46"],
  ["2027-05-11", "Valet Parking", "35.00"],
  ["2027-05-11", "Minibar", "18.50"],
  ["2027-05-12", "Room Charge", "189.00"],
  ["2027-05-12", "Occupancy Tax (14%)", "26.46"],
  ["2027-05-12", "Sequoia Grill - Breakfast", "22.75"],
  ["2027-05-12", "Cascade Spa - Massage", "85.00"],
];

const summary = [
  ["Room Subtotal", "567.00"],
  ["Tax Total", "79.38"],
  ["Incidentals Subtotal", "215.50"],
  ["TOTAL", "861.88"],
  ["Payment - Visa ****4242 (2027-05-13)", "-861.88"],
  ["BALANCE DUE", "0.00"],
];

function escapeText(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

const ops = [];
function text(x, y, font, size, value) {
  ops.push(`BT /${font} ${size} Tf ${x} ${y} Td (${escapeText(value)}) Tj ET`);
}

let y = 740;
text(170, y, "F2", 18, "GRAND SEQUOIA HOTEL");
y -= 18;
text(160, y, "F1", 10, "1200 Canyon Rim Drive, Bend, OR 97701");
y -= 14;
text(200, y, "F1", 10, "(541) 555-0188 - grandsequoia.example.com");

y -= 34;
text(72, y, "F2", 13, "GUEST FOLIO");
y -= 20;
text(72, y, "F1", 11, "Folio Number: GS-88214");
text(330, y, "F1", 11, "Room: 412 (Deluxe King)");
y -= 16;
text(72, y, "F1", 11, "Guest: Jamie Rivera");
text(330, y, "F1", 11, "Nightly Rate: $189.00");
y -= 16;
text(72, y, "F1", 11, "Check-In: 2027-05-10");
text(330, y, "F1", 11, "Check-Out: 2027-05-13 (3 nights)");

y -= 30;
text(72, y, "F2", 12, "ITEMIZED CHARGES");
y -= 20;
const row = (date, description, amount) =>
  `${date.padEnd(12)}${description.padEnd(34)}${amount.padStart(10)}`;
text(72, y, "F3", 10, row("DATE", "DESCRIPTION", "AMOUNT"));
y -= 6;
text(72, y, "F3", 10, "-".repeat(56));
for (const [date, description, amount] of charges) {
  y -= 14;
  text(72, y, "F3", 10, row(date, description, amount));
}

y -= 10;
text(72, y, "F3", 10, "-".repeat(56));
for (const [label, amount] of summary) {
  y -= 14;
  text(72, y, "F3", 10, row("", label, amount));
}

y -= 34;
text(72, y, "F1", 10, "All amounts in USD. Thank you for staying with us!");

const content = ops.join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> " +
    "/Contents 7 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [];
for (const [index, body] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
}
const xrefOffset = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from(pdf, "latin1"));
console.log(`Wrote ${outputPath} (${pdf.length} bytes)`);
