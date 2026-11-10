// Built-in field guidance used when the ground server cannot be reached.
// Generated from server/knowledge.py — keep the two in sync.
const TOPICS = [
 {
  "keys": [
   "triage",
   "start triage",
   "prioritise",
   "prioritize",
   "mass casualty",
   "many injured"
  ],
  "answer": "START triage (about 30 seconds per person):\n1. Can walk? -> GREEN (minor). Move them to a collection point.\n2. Not breathing? Open the airway. Still not breathing -> BLACK (expectant). Breathing now -> RED.\n3. Breathing over 30 a minute -> RED (immediate).\n4. No radial pulse, or capillary refill over 2 seconds -> RED. Control major bleeding first.\n5. Cannot follow simple commands -> RED. Otherwise -> YELLOW (delayed).\nTag each person and re-triage as resources arrive."
 },
 {
  "keys": [
   "crush",
   "pinned",
   "compression",
   "trapped limb",
   "crush syndrome"
  ],
  "answer": "Crush injury (limb or body pinned for a long time, especially over 1 hour):\n1. Do not release a long-trapped person without medical support if it can be arranged.\n2. A trained medic should start IV fluids before release where possible.\n3. After release, watch for sudden collapse or irregular heartbeat — toxins enter the blood.\n4. Keep them warm, monitor breathing and pulse, and transport urgently to hospital.\n5. Treat life-threatening bleeding immediately."
 },
 {
  "keys": [
   "collapsed building",
   "structure",
   "void",
   "confined space",
   "entry",
   "search building"
  ],
  "answer": "Collapsed-structure safety:\n1. Size up first: gas, electricity, water, unstable walls, aftershock risk.\n2. Never enter alone. Keep a safety officer outside who tracks who is inside.\n3. Shore or avoid leaning walls and hanging slabs; use the most stable route.\n4. Call-out and listen: shout, then 2 minutes of total silence to hear tapping.\n5. Mark searched areas clearly so other teams do not repeat them.\n6. Wear helmet, gloves, dust mask and eye protection."
 },
 {
  "keys": [
   "water rescue",
   "drowning",
   "swift water",
   "boat",
   "river"
  ],
  "answer": "Water rescue — reach, throw, row, then go:\n1. REACH with a pole or rope from a safe spot.\n2. THROW a buoyant object or throw-bag.\n3. ROW out by boat if trained and equipped.\n4. GO into the water only as a last resort, trained and with a life jacket.\nNever tie a rope around a rescuer in moving water. After rescue, check breathing and treat for cold."
 },
 {
  "keys": [
   "hypothermia",
   "cold",
   "shivering"
  ],
  "answer": "Hypothermia: move the person out of wind and water, remove wet clothes, insulate from the ground, cover with dry blankets including the head. Give warm sweet drinks only if fully alert. Handle gently — rough movement can trigger heart problems. Get medical help."
 },
 {
  "keys": [
   "spinal",
   "spine",
   "neck injury",
   "back injury"
  ],
  "answer": "Suspected spinal injury: keep the head and neck in line with the body. Do not move the person unless there is immediate danger. If you must move them, use several people and log-roll as one unit. Keep them still and warm until a stretcher or medical team arrives."
 },
 {
  "keys": [
   "earthquake",
   "quake",
   "tremor",
   "aftershock",
   "shaking"
  ],
  "answer": "During shaking: DROP, COVER under a sturdy table, HOLD ON. Stay away from glass, shelves and outer walls. If outdoors, move to an open area away from buildings, trees and power lines.\n\nAfter shaking: expect aftershocks. Check yourself and others for injuries. Do not use lifts. Leave damaged buildings carefully and do not re-enter. If you smell gas, do not use switches or flames — leave and report it."
 },
 {
  "keys": [
   "trapped",
   "stuck",
   "rubble",
   "debris",
   "buried",
   "collapsed"
  ],
  "answer": "If you are trapped: stay calm and move as little as possible so you do not stir up dust. Cover your mouth and nose with cloth. Tap on a pipe or wall 3 times at a time so rescuers can hear you — shout only as a last resort to save energy. Do not light a match. Press SOS in this app if you can: it sends your location to the rescue team. Rescue aircraft use thermal cameras, so keep visible skin or a phone light pointed at any gap."
 },
 {
  "keys": [
   "flood",
   "water rising",
   "flooding",
   "inundation"
  ],
  "answer": "Move to higher ground immediately. Do not walk through moving water — 15 cm can knock you down. Do not drive through flooded roads. Switch off electricity at the mains if it is safe to do so. Stay away from drains and fallen power lines. If trapped in a building, go to the highest floor or roof (not a closed attic) and signal for help."
 },
 {
  "keys": [
   "fire",
   "smoke",
   "burning",
   "wildfire"
  ],
  "answer": "Get out and stay out. Crawl low under smoke. Feel doors with the back of your hand before opening — if hot, use another way. If clothes catch fire: STOP, DROP and ROLL. Close doors behind you to slow the fire. Call 101 once you are safe."
 },
 {
  "keys": [
   "landslide",
   "mudslide",
   "slope"
  ],
  "answer": "Move away from the path of the slide, sideways and to higher ground. Listen for rumbling, cracking trees or tilting poles — these are warning signs. Stay away from the slide area afterwards; more slides can follow. Report broken utility lines."
 },
 {
  "keys": [
   "cyclone",
   "storm",
   "hurricane",
   "wind",
   "typhoon"
  ],
  "answer": "Stay indoors away from windows, in the strongest room. Keep a torch, radio, water and medicines ready. Do not go out during the calm 'eye' — winds return from the other direction. After the storm, avoid fallen power lines and flooded areas."
 },
 {
  "keys": [
   "bleeding",
   "blood",
   "wound",
   "cut"
  ],
  "answer": "Press firmly on the wound with a clean cloth and keep pressing for at least 10 minutes. Raise the injured part above the heart if possible. If blood soaks through, add more cloth on top — do not remove the first layer. For life-threatening limb bleeding that will not stop, a tight band above the wound may be needed. Get medical help: 108."
 },
 {
  "keys": [
   "cpr",
   "not breathing",
   "unconscious",
   "no pulse",
   "heart"
  ],
  "answer": "Check for response and breathing. If not breathing normally: call 108, then push hard and fast in the centre of the chest — about 5–6 cm deep, 100–120 pushes a minute. Do not stop until help arrives or the person starts breathing."
 },
 {
  "keys": [
   "burn",
   "burnt"
  ],
  "answer": "Cool the burn under cool running water for 20 minutes. Remove rings or tight items near the area. Do not use ice, butter or toothpaste. Cover loosely with clean cling film or a clean cloth. Seek medical help for large, deep or facial burns."
 },
 {
  "keys": [
   "fracture",
   "broken bone",
   "sprain"
  ],
  "answer": "Keep the injured part still. Support it in the position found using padding or a makeshift splint. Do not try to straighten it. Apply a cold pack wrapped in cloth. Get medical help."
 },
 {
  "keys": [
   "water",
   "drink",
   "thirst",
   "dehydration"
  ],
  "answer": "Drink only safe water: bottled, boiled (rolling boil for 1 minute) or treated with purification tablets. Flood water is contaminated — do not drink it or wash food in it. Small regular sips are better than large amounts at once."
 },
 {
  "keys": [
   "gas",
   "leak",
   "smell"
  ],
  "answer": "Do not switch lights or appliances on or off, and do not use flames or phones inside. Open doors and windows if it is safe, leave the building, and report the leak from outside. Mark it in the app with 'Report hazard'."
 },
 {
  "keys": [
   "kit",
   "prepare",
   "emergency bag",
   "supplies",
   "go bag"
  ],
  "answer": "Emergency kit: water (3 litres per person per day), packaged food, torch and spare batteries, power bank, first-aid kit, regular medicines, copies of ID documents, cash, whistle, dust mask, warm clothing, and a printed list of phone numbers."
 },
 {
  "keys": [
   "sos",
   "how to call",
   "emergency number",
   "number"
  ],
  "answer": "Survivors send SOS calls from the public page at /sos on this server (share the address or a QR code). Their calls appear as cases in the Cases tab. Accept a case, then use the message box to reply — survivors see your replies on their SOS page. Emergency numbers (India): 112 all emergencies · 108 ambulance · 101 fire · 100 police · 1078 disaster management helpline."
 },
 {
  "keys": [
   "drone",
   "uav",
   "aircraft",
   "thermal"
  ],
  "answer": "Rescue aircraft search the area in parallel strips and use thermal and depth cameras to find people. If you hear one overhead, move into the open if safe, wave a bright cloth or a phone light, and stay where you are so your location stays accurate."
 },
 {
  "keys": [
   "gps",
   "location",
   "wifi",
   "wi-fi"
  ],
  "answer": "Open Settings (gear icon). Turn on GPS for the most accurate position outdoors. Turn on Wi-Fi positioning to get a faster, rougher fix indoors or near buildings. Keep both on if you can. Turning both off stops location sharing."
 }
];
const NUMBERS = "Emergency numbers (India): 112 all emergencies · 108 ambulance · 101 fire · 100 police · 1078 disaster management helpline.";
const FALLBACK = "Offline mode: answering from built-in field guidance. Try: START triage, crush injury, collapsed building safety, water rescue, bleeding, CPR, burns, spinal injury, hypothermia, gas leak.\n\nEmergency numbers (India): 112 all emergencies · 108 ambulance · 101 fire · 100 police · 1078 disaster management helpline.";

export function offlineAnswer(question) {
  const q = (question || "").toLowerCase();
  const hits = TOPICS.filter((t) => t.keys.some((k) => q.includes(k)));
  if (!hits.length) return FALLBACK;
  return hits.slice(0, 2).map((h) => h.answer).join("\n\n") + "\n\n" + NUMBERS;
}
