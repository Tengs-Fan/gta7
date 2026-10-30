// STATIC 1260 AM, Beyond the Bay: late-night conspiracy call-in, where it's always 3 AM. Lyle Truett, who moved to San
// Azura to be closer to the signal, has a theory about every landmark you can see from the car; Gary from the Westside,
// whom Chet Bramble laughs at, is his man in the field; Doris's cat is still at the top of Moreau Tower; and between
// calls a flat voice reads the Signal.

import type { Line, TalkPiece } from '../script';

const PIECES: readonly TalkPiece[] = [
  // Lyle Truett's theories, each about a place you can go and look at.
  {
    id: 'static-host-lighthouse',
    kind: 'host',
    lines: [
      ['lyle', "Good evening. Or good morning. On Static it's always three AM. I'm Lyle Truett, and I moved to San Azura to be closer to the signal."],
      ['lyle', "Tonight, the lighthouse at Azura Point. It turns all night, every night. The city says it's for ships. Name one ship. Go on. I've watched from the point for six years, and I have seen one ship, and it was a pedalo."],
      ['lyle', "A light that turns all night with nobody to see it isn't warning anyone off. It's calling someone in. The question isn't what it's for. The question is who's coming."],
    ],
  },
  {
    id: 'static-host-wheel',
    kind: 'host',
    lines: [
      ['lyle', "The Ferris wheel on Azura Pier turns one way. Have you noticed? Stand on the pier and watch it. It never goes back. Not once, in all the years I've been listening."],
      ['lyle', "Now, a wheel that only turns one way isn't a ride. It's a winder, like the key in the back of a clock. Something under that pier is being wound up, a little more every night."],
      ['lyle', "And the man who stops it at the top for twenty minutes? He isn't lazy. He's letting it rest. I'd stop it too, if I knew what it was winding."],
    ],
  },
  {
    id: 'static-host-canal',
    kind: 'host',
    lines: [
      ['lyle', 'Cortez Canal. Coast to coast, dead straight, right through the middle of the city. Dug by the founders, they tell you. Dug by whom?'],
      ['lyle', "Have you seen the founders? There's a painting of them in City Hall, and not one of them is holding a shovel. Men in wigs did not dig that canal. Men in wigs have never dug anything."],
      ['lyle', "No. Something cut this city in two, cleanly, the way you'd cut a cake to see what's inside. And whatever it found in there, it put the bridges back, so we wouldn't notice."],
    ],
  },
  {
    id: 'static-host-ring',
    kind: 'host',
    lines: [
      ['lyle', "Let's talk about the ring road. One road, all the way round the city, joined up at both ends. Ask yourself why anybody builds a circle."],
      ['lyle', "A circle doesn't go anywhere. You don't build a circle to get somewhere. You build it to keep something in. Or, and I want you to sit with this, to draw something down."],
      ['lyle', "The mayor wants you to embrace the journey. The journey is a ring, my friends, and every pothole on it is a point in a pattern. I've mapped them. It's a face."],
    ],
  },
  {
    id: 'static-host-tower',
    kind: 'host',
    lines: [
      ['lyle', 'Moreau Tower. Forty two floors of glass in the middle of downtown, with a helipad on the roof that no helicopter has ever been seen to use.'],
      ['lyle', "Ask who owns it. You'll get a name. Moreau. Ask what Moreau does, and you'll get a long silence and, in my case, a parking ticket."],
      ['lyle', "I'll tell you what a tower that tall with nothing on the roof is. It's an aerial. And the only one up there who seems to know it is a cat."],
    ],
  },
  {
    id: 'static-host-gulls',
    kind: 'host',
    lines: [
      ['lyle', 'Chet Bramble on one oh four point five thinks the gulls at Ocean Beach are organised. Chet, bless him, is half right.'],
      ['lyle', 'Go down to the beach at dawn and look at them. Hundreds of gulls, every one facing the same way, out to sea. Not eating. Not squawking. Listening.'],
      ['lyle', "They're not organised, Chet. They're relays. Every gull on that beach is passing something on, bird to bird, down the coast. The chips are just how they get paid."],
    ],
  },

  // Callers.
  {
    id: 'static-call-gary',
    kind: 'call',
    lines: [
      ['lyle', 'Gary from the Westside, our man in the field. Go ahead, Gary.'],
      ['gary', 'Lyle, I told the other guy about the lighthouse and he laughed at me.'],
      ['lyle', 'Chet Bramble laughs at everything, Gary.'],
      ['gary', "He said it's been going round for a hundred years. And I said, exactly. Patient. Very patient."],
      ['lyle', 'Good man. Did you get the readings?'],
      ['gary', 'I sat on the point all night with a compass. It went round eleven hundred times, Lyle. And on the last one, it blinked.'],
      ['lyle', "Lighthouses don't blink, Gary."],
      ['gary', "That's what I'm saying."],
    ],
  },
  {
    id: 'static-call-cat',
    kind: 'call',
    lines: [
      ['lyle', "Doris, you're on Static. How's the cat?"],
      ['doris', "Still at the top of Moreau Tower, Lyle. Six weeks now. The fire brigade won't go up."],
      ['lyle', 'Is he eating?'],
      ['doris', "He doesn't seem to need to. He just sits on the edge, facing the sea, with his ears up. Everyone keeps saying he's stuck."],
      ['lyle', 'And what do you say, Doris?'],
      ['doris', "I don't think he's stuck. I think he's receiving."],
      ['lyle', 'I think you might be right. Keep his bowl out.'],
    ],
  },
  {
    id: 'static-call-lights',
    kind: 'call',
    lines: [
      ['lyle', "Trish, you're on Beyond the Bay."],
      ['trish', 'Lyle, Chet said on Azura Talk that the lights in Midtown are green for exactly four seconds.'],
      ['lyle', 'I heard him.'],
      ['trish', "So I sat at Sunset and Market with a notebook. Four seconds green. Then red. Then four seconds green. It's not timing, Lyle. It's Morse code."],
      ['lyle', 'What does it say?'],
      ['trish', 'So far? Go. Stop. Go. Stop.'],
      ['lyle', "Trish. That's a traffic light."],
      ['trish', "That's what they want you to think."],
    ],
  },
  {
    id: 'static-call-sal',
    kind: 'call',
    lines: [
      ['lyle', 'Line two, Sal from Southgate. Sal, you usually ring the sports station.'],
      ['sal', "Big Ron hung up on me, Lyle. The Gulls haven't won in twelve games. Nobody loses that much by themselves. It's the signal."],
      ['lyle', 'You think the signal is making them lose?'],
      ['sal', 'What else could it be?'],
      ['lyle', "Sal, I've looked into the Gulls. The signal doesn't go near them. Some things in this city have a perfectly ordinary explanation."],
      ['sal', 'Like what?'],
      ['lyle', 'The Gulls, Sal. The Gulls are just bad.'],
    ],
  },
  {
    id: 'static-call-lawn',
    kind: 'call',
    lines: [
      ['lyle', "Linda in Hillcrest, you're on Static."],
      ['linda', "Lyle, there are men from the homeowners association in my front yard at three in the morning. With a tape measure."],
      ['lyle', 'What are they measuring?'],
      ['linda', 'My grass. One blade at a time. They write it all down, then they look up at the sky, and they nod.'],
      ['lyle', 'Linda, every lawn in Hillcrest is exactly the same height. Have you ever wondered what that looks like from above?'],
      ['linda', 'A landing strip?'],
      ['lyle', 'Mow yours crooked. Tonight.'],
    ],
  },
  {
    id: 'static-call-kid',
    kind: 'call',
    lines: [
      ['lyle', "Line four, you're on Static. It's very late."],
      ['kid', 'Hi! Is this the radio?'],
      ['lyle', "It is. Shouldn't you be asleep?"],
      ['kid', "My dad's driving me round the ring road so I fall asleep. We've been round six times."],
      ['lyle', 'Six times round a circle. Is anything following you?'],
      ['kid', 'Just the moon.'],
      ['lyle', 'Tell your dad to take the next exit. And wave at the moon, so it knows you saw it.'],
    ],
  },

  // The Signal, read flat between calls.
  {
    id: 'static-news-gulls',
    kind: 'news',
    lines: [
      ['lyle', "It's three AM. Time for the Signal."],
      ['reader', 'Seven. Four. Gull. Gull. Nine. Repeat. Seven. Four. Gull. Gull. Nine.'],
      ['lyle', 'Write that down. All of it.'],
    ],
  },
  {
    id: 'static-news-wheel',
    kind: 'news',
    lines: [
      ['lyle', 'The Signal, picked up tonight from somewhere out past the lighthouse.'],
      ['reader', 'Three. Three. Wheel. Turns. One. Way. Three. Three. Message ends.'],
      ['lyle', 'Well. I did tell you.'],
    ],
  },
  {
    id: 'static-news-ducks',
    kind: 'news',
    lines: [
      ['lyle', 'Quiet, please. The Signal.'],
      ['reader', 'Ten. Thousand. Duck. Container. Forty. Four. Repeat. Duck. Duck. Duck.'],
      ['lyle', "I don't know what that one means. But I'd wager somebody on SAPR does."],
    ],
  },

  // Ads only STATIC runs (it also carries Torque, Taco Tornado, Azura Mutual and Hillcrest Heights, script.ts). Lyle's
  // hat goes on from one break to the next.
  {
    id: 'static-ad-bunker',
    kind: 'ad',
    lines: [
      ['announcer', "Bunker in a Box! Everything you need to survive the end of the world, the end of the month, or a visit from the in-laws. Three rooms, a wind-up radio, and enough canned beans for a year, or a very long weekend."],
      ['announcer', "Delivered flat, and buried in your back garden overnight. Hillcrest HOA approved, once they find it. Bunker in a Box."],
      ['announcer', 'Do not bury Bunker in a Box near a gas line, a neighbour, or another Bunker in a Box. Daylight not included.', { speed: 1.5 }],
    ],
  },
  {
    id: 'static-ad-hat',
    kind: 'ad',
    series: 'static-hat',
    part: 1,
    lines: [
      ['lyle', "Friends, Lyle here. People ask me how I sleep at night. I don't, it's three AM. But when I do, I wear the Signal Blocker hat."],
      ['lyle', "Hand-lined with genuine kitchen foil. Keeps the signal out, and your thoughts in. One size fits most heads. Available in beige, or beige. The Signal Blocker hat. Because they're listening."],
    ],
  },
  {
    id: 'static-ad-hat-pulse',
    kind: 'ad',
    series: 'static-hat',
    part: 2,
    lines: [
      ['lyle', "Friends, Lyle again, about the Signal Blocker hat. A few of you have written in to say that, with the hat on, you can hear Pulse, ninety six point one. Clearly. All night."],
      ['lyle', "That's a feature. Four on the floor is a very hard signal to get through. If it keeps you up, try wearing it the other way round. The Signal Blocker hat. Now with a chin strap, for windy nights on Azura Point."],
    ],
  },

  // Station idents, played over the jingle's bells.
  { id: 'static-ident-three', kind: 'ident', lines: [['lyle', "Static, twelve sixty AM. Beyond the Bay. It's always three AM here."]] },
  { id: 'static-ident-signal', kind: 'ident', lines: [['lyle', "This is Lyle Truett. You're listening to Static, twelve sixty AM. Stay close to the signal."]] },
  { id: 'static-ident-gary', kind: 'ident', lines: [['gary', 'Gary from the Westside. There is one station I trust. Static, twelve sixty AM.']] },
  { id: 'static-ident-reader', kind: 'ident', lines: [['reader', 'Twelve. Sixty. Static. Repeat. Static.']] },
];

/** The reader reads the Signal slowly, wherever she is heard. */
const paced = (l: Line): Line => (l[0] === 'reader' ? [l[0], l[1], { speed: 0.9, ...l[2] }] : l);

export const STATIC: readonly TalkPiece[] = PIECES.map((p) => ({ ...p, show: 'static', lines: p.lines.map(paced) }));
