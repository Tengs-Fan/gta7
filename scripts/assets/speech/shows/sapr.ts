// SAPR 107.3, San Azura Public Radio: calm voices and a pledge drive that never ends. Reginald Ashcombe-Pryce, critic
// at large, reviews the city as fine art; Pru's Garden Line takes calls about gardens that may be crime scenes; Marjorie
// runs the pledge drive; and Harbor Lights, a noir serial in five chapters aired in order, solves the case of the ten
// thousand rubber ducks that Chet, Dolores and THE BOWL have been on about for weeks.

import type { Line, TalkPiece } from '../script';

const PIECES: readonly TalkPiece[] = [
  // Reginald Ashcombe-Pryce reviews the city.
  {
    id: 'sapr-host-alarm',
    kind: 'host',
    lines: [
      ['reginald', 'Good evening. Reginald Ashcombe-Pryce, critic at large. Tonight, the car alarm on Market Street, which has performed nightly since March.'],
      ['reginald', 'It is a bold work in three movements. A whoop. A second whoop. And a long, contemptuous beep. The owner has never once come out to silence it, and that, I think, is the point.'],
      ['reginald', 'Nobody asked for it. Nobody can stop it. It is the most honest thing in San Azura. Five stars. I have not slept since March.'],
    ],
  },
  {
    id: 'sapr-host-burrito',
    kind: 'host',
    lines: [
      ['reginald', 'This week I dined at the Taco Tornado on Southgate Square, and ordered, against the advice of the staff, the Inferno Burrito.'],
      ['reginald', 'It arrives in foil, like a casualty. It is not a meal. It is a dare that has learned to wrap itself. The first bite is cumin and regret. The second, I am told, is where you see your grandmother.'],
      ['reginald', 'I saw mine. She was disappointed. Four stars, and a waiver.'],
    ],
  },
  {
    id: 'sapr-host-wheel',
    kind: 'host',
    lines: [
      ['reginald', 'To Azura Pier, and the Ferris wheel, which on Saturday carried me to the very top and then, with tremendous restraint, stopped. For twenty minutes.'],
      ['reginald', 'Lesser wheels go round. This one has the courage to withhold. Below me, a child wept. A gull took my hat. The operator called up, enjoy the view, and I understood that I was not on a ride. I was in a piece of theatre.'],
      ['reginald', 'Eleven dollars. An intermission with no second act. I have booked again for Tuesday.'],
    ],
  },
  {
    id: 'sapr-host-exhaust',
    kind: 'host',
    lines: [
      ['reginald', 'I was cut up this morning on the ring road by a Thunderhoof, and I should like to review its exhaust.'],
      ['reginald', 'It opens fortissimo, at a red light, for no one. It is a work of profound insecurity. Every note says, look at me. And every note says, please, do not look too closely.'],
      ['reginald', 'The driver revved it twice more at the next light, in case I had missed the theme. I had not. Two stars. One for the exhaust, and one for the man, who I suspect is lovely to his mother.'],
    ],
  },
  {
    id: 'sapr-host-chet',
    kind: 'host',
    lines: [
      ['reginald', "There is a man on one oh four point five who shouts for a living. I shan't name him. His name is Chet."],
      ['reginald', 'I listened to his programme for one hour, in the interests of criticism. He shouted at a traffic light. He shouted at a seagull. He shouted at a child, who had rung in to ask whether he was the radio.'],
      ['reginald', 'And yet there is something in it, the way there is something in a fire alarm. One star, and my deepest sympathy to his microphone.'],
    ],
  },

  // Pru's Garden Line.
  {
    id: 'sapr-call-roses',
    kind: 'call',
    lines: [
      ['pru', "Pru's Garden Line, you're on SAPR. Hello, darling."],
      ['linda', "Hi, Pru. It's Linda, in Hillcrest. Something's buried under my roses."],
      ['pru', 'Bulbs? A cat?'],
      ['linda', "It's wearing a watch."],
      ['pru', 'Is the watch still going?'],
      ['linda', "It is. It's quite a nice watch."],
      ['pru', "Then it isn't your problem, darling, it's his. Mulch over it, plant lavender, and water deeply. Lavender forgives everything."],
    ],
  },
  {
    id: 'sapr-call-fence',
    kind: 'call',
    lines: [
      ['pru', "Marcus, you're on Pru's Garden Line."],
      ['marcus', "Pru, there's a fence behind my taco truck in Southgate. Monday, somebody paints it teal. Tuesday, somebody paints it red. Wednesday, teal again."],
      ['pru', "Who's painting it?"],
      ['marcus', "The Tiburones and the Halcones. I don't ask, Pru. They tip well."],
      ['pru', 'Teal, darling. Plant hydrangeas and let them sort out the rest.'],
      ['marcus', 'The hydrangeas?'],
      ['pru', 'They come up blue in acid soil and red in chalk. Whoever wins, the garden agrees with them.'],
    ],
  },
  {
    id: 'sapr-call-hedge',
    kind: 'call',
    lines: [
      ['pru', "Doris, you're on the Garden Line."],
      ['doris', "Pru, my neighbour's hedge has been growing ever so fast since his wife went to stay with her sister."],
      ['pru', 'How long has she been away?'],
      ['doris', 'Four years. And the hedge has come up in the shape of a lady. With a handbag.'],
      ['pru', "Topiary, Doris. Some men grieve with shears. Feed it in the spring, and never prune below the handbag."],
      ['doris', 'Thank you, Pru.'],
      ['pru', 'And Doris? If he offers you any compost, say no.'],
    ],
  },
  {
    id: 'sapr-call-ducks',
    kind: 'call',
    lines: [
      ['pru', "Jen, you're on the air."],
      ['jen', "Pru, I moved onto a houseboat at the Marina, and I grow tomatoes in a bucket. Every morning there are rubber ducks in it. Dozens. Yellow."],
      ['pru', 'Have you tried netting?'],
      ['jen', "They come over the side in the night, Pru. They're very determined."],
      ['pru', 'Then leave them be, darling. Anything that has crossed Port Basin to sit in your tomatoes has earned it. We call that companion planting.'],
    ],
  },
  {
    id: 'sapr-call-orchard',
    kind: 'call',
    lines: [
      ['pru', "Vince, you're on Pru's Garden Line."],
      ['vince', "Pru, I jog through Azura Park at night, and every Thursday there's a guy digging a hole. A long one. He puts in a big bag, fills it in, and plants a little tree on top."],
      ['pru', 'What sort of tree?'],
      ['vince', 'Does it matter?'],
      ['pru', "It's the only thing that matters. A willow, he's a romantic. A yew, he means to stay. How many has he planted?"],
      ['vince', "Eleven. It's turning into a nice little orchard."],
      ['pru', 'Then the council should give him a prize, darling, and you should jog on Wednesdays.'],
    ],
  },

  // The pledge drive.
  {
    id: 'sapr-news-tote',
    kind: 'news',
    lines: [
      ['marjorie', "This is Marjorie, and it's pledge week here at SAPR. It has been pledge week since the spring."],
      ['marjorie', 'For a pledge of sixty dollars, you will receive the SAPR tote bag. And for a pledge of one hundred and twenty, Reginald will stop describing the tote bag.'],
      ['reginald', 'It is canvas. It is beige. It has endured.'],
      ['marjorie', 'The lines are open.'],
      ['reginald', 'It has two handles. Each, in its own way, a handle.'],
      ['marjorie', 'Please. Call now.'],
    ],
  },
  {
    id: 'sapr-news-goal',
    kind: 'news',
    lines: [
      ['marjorie', 'A word about our pledge drive. Our goal tonight is forty thousand dollars. So far we have raised eleven dollars, and a coupon for the Taco Tornado.'],
      ['marjorie', 'The coupon has been claimed. Reginald used it.'],
      ['reginald', 'I regret very little.'],
      ['marjorie', 'If you listen to SAPR, and it seems that some of you do, please pledge now. If we reach our goal, we will never ask again. That is a lie. But it is a calm one.'],
    ],
  },
  {
    id: 'sapr-news-garden',
    kind: 'news',
    lines: [
      ['marjorie', 'Pledge two hundred dollars tonight, and you will receive the SAPR mug, and Pru will come to your home and look at your garden.'],
      ['pru', "Just look, darling. I won't dig."],
      ['marjorie', "For five hundred, she'll dig."],
      ['pru', "For five hundred, I won't ask what I find."],
      ['marjorie', 'Our volunteers are standing by. Both of them. They are very calm.'],
    ],
  },

  // Harbor Lights, one chapter a clip, aired in this order.
  {
    id: 'sapr-serial-1',
    kind: 'serial',
    lines: [
      ['announcer', 'SAPR presents Harbor Lights. Chapter one: The Client.'],
      ['announcer', 'Previously on Harbor Lights: nothing. This is the first one.'],
      ['sam', 'The rain came down on Southgate like it owed somebody money. My office is over the Taco Tornado on Southgate Square. The rent is cheap, the floor is warm, and in summer it smells like a fire at a spice market.'],
      ['sam', 'I was eating lunch out of the bottom drawer when she walked in. Tall, wet, and wearing a coat that cost more than my car. My car is a Pipsqueak, so that is not saying much.'],
      ['marguerite', 'Mister Ketch? Marguerite Vale, of the Pelican Harbor Bath Emporium.'],
      ['sam', 'Sit down. Mind the chair, it bites.'],
      ['marguerite', 'Mister Ketch, someone has stolen ten thousand ducks.'],
      ['sam', 'Real ducks?'],
      ['marguerite', 'Rubber.'],
      ['sam', "That's worse. Real ducks come home."],
      ['marguerite', 'They were in a container at Port Basin on Friday night. On Saturday morning, it was gone. The police laughed at me. A man on the radio laughed at me.'],
      ['sam', "That'd be Chet. He laughs at everything. I get fifty a day, plus expenses."],
      ['marguerite', 'What sort of expenses?'],
      ['sam', 'Burritos, mostly.'],
      ['sam', "She left a photograph on my desk. Ten thousand ducks, smiling. I didn't like the way they smiled. Like they knew something I didn't."],
      ['announcer', 'Next time on Harbor Lights: the docks, the crane, and a man called Lefty.'],
    ],
  },
  {
    id: 'sapr-serial-2',
    kind: 'serial',
    lines: [
      ['announcer', 'SAPR presents Harbor Lights. Chapter two: The Crane.'],
      ['announcer', 'Previously on Harbor Lights: ten thousand rubber ducks went missing at Port Basin, and Sam Ketch took the case, for fifty a day and burritos.'],
      ['sam', 'Port Basin at midnight. Three cranes against the sky, like giraffes that had given up. The water was black, and the gulls were watching. In this town, the gulls are always watching.'],
      ['sam', 'Lefty Szabo runs the middle crane. Twenty years on the docks, and he never dropped a thing. Except his marriage, and that was her idea.'],
      ['lefty', "You're the duck guy."],
      ['sam', 'Word gets around.'],
      ['lefty', 'I lift what they tell me to lift, pal. Friday night they tell me, lift container forty four. So I lift container forty four.'],
      ['sam', 'Anything strange about it?'],
      ['lefty', 'It was light. It came up like a box of air. Like the whole thing wanted to float.'],
      ['sam', 'Who told you to lift it?'],
      ['lefty', 'Guy in a suit, with a clipboard. Said he was from head office.'],
      ['sam', "Everybody on the docks is from head office. Nobody's ever seen head office. Where'd you put it down?"],
      ['lefty', "That's the thing. I didn't. He told me to swing it out over the water and wait. Then he says, that's fine, Lefty, go get a coffee. When I got back, the hook was empty."],
      ['sam', "Lefty's hands were steady. A crane man's hands are always steady. It's the rest of him you worry about."],
      ['announcer', 'Next time on Harbor Lights: the harbour master, who says nothing and stamps everything.'],
    ],
  },
  {
    id: 'sapr-serial-3',
    kind: 'serial',
    lines: [
      ['announcer', 'SAPR presents Harbor Lights. Chapter three: The Harbour Master.'],
      ['announcer', 'Previously on Harbor Lights: Lefty Szabo swung container forty four out over Port Basin for a man with a clipboard, and went for a coffee.'],
      ['sam', "The harbour master's office is a shed at the end of the wharf with a flag on it. Inside sat a man in a captain's hat, who has not said a word since nineteen ninety one."],
      ['sam', "He doesn't talk. He stamps. He has a stamp for everything. I asked him if he remembered container forty four. He looked at me for a long time. Then he stamped my hand. It said, received."],
      ['sam', 'I asked him where it went. He stamped my other hand. It said, lost at sea.'],
      ['sam', "I said, there's no sea in Port Basin, pal, it's a basin. He thought about that. Then he stamped my forehead. It said, denied."],
      ['sam', 'I took his logbook while he looked for a stamp that said, get out. Friday night, eleven forty. Container forty four, lost at sea, an hour before anybody lost it. And under it, a signature. A claims adjuster. Very neat handwriting. Too neat.'],
      ['sam', 'I walked back along the wharf with received on one hand, lost at sea on the other, and denied on my face. Which is how most people leave the docks.'],
      ['announcer', 'Next time on Harbor Lights: Sam Ketch goes down to Ocean Beach, and questions a gull.'],
    ],
  },
  {
    id: 'sapr-serial-4',
    kind: 'serial',
    lines: [
      ['announcer', 'SAPR presents Harbor Lights. Chapter four: The Gulls.'],
      ['announcer', 'Previously on Harbor Lights: the harbour master stamped Sam Ketch three times, and a claims adjuster signed for a container nobody had lost yet.'],
      ['sam', "Every racket in this city has a lookout, and on Ocean Beach the lookouts have wings. I found the big one by the pier, standing on one leg, eating somebody's fries like he'd paid for them."],
      ['sam', "I leaned on him. He leaned back. Gulls don't crack. They've got nothing to lose but your lunch."],
      ['marguerite', 'Mister Ketch, are you interrogating a seagull?'],
      ['sam', 'Miss Vale. You followed me.'],
      ['marguerite', "I'm paying fifty a day. I wanted to see what fifty a day looks like."],
      ['sam', "It looks like this. Look at the waterline."],
      ['sam', 'She looked. All along Ocean Beach, from the pier to the Marina, little yellow heads were bobbing in the surf. Hundreds of them. Thousands. Smiling.'],
      ['marguerite', 'My ducks.'],
      ['sam', "Nobody carried them off, Miss Vale. They're coming in on the tide."],
      ['marguerite', 'Then the gulls are innocent?'],
      ['sam', 'Nobody in this town is innocent. These ones are just hungry.'],
      ['sam', "The gull took the last fry and walked off up the beach, slow, like a guy who knows you've got nothing on him."],
      ['announcer', "Next time on Harbor Lights, the last chapter: who sank container forty four, and who's paying?"],
    ],
  },
  {
    id: 'sapr-serial-5',
    kind: 'serial',
    lines: [
      ['announcer', 'SAPR presents Harbor Lights. Chapter five: The Policy.'],
      ['announcer', 'Previously on Harbor Lights: the ducks came in on the tide at Ocean Beach, and the gull walked.'],
      ['sam', 'I did what any detective does when the trail goes cold. I bought a burrito, and I read the small print.'],
      ['sam', 'Container forty four was insured with Azura Mutual, ten thousand ducks for a million dollars. The man with the clipboard was theirs. So was the neat handwriting.'],
      ['marguerite', 'Mister Ketch, who stole my ducks?'],
      ['sam', 'Nobody stole them, Miss Vale. Azura Mutual sank the container for the insurance.'],
      ['marguerite', 'But Azura Mutual is the insurance.'],
      ['sam', "That's why the claim was denied. They've been trying to collect from themselves for a month. Nobody's picking up."],
      ['marguerite', 'And my ducks?'],
      ['sam', 'Your ducks did what ducks do. They floated. Round Port Basin, past the Marina, up Ocean Beach, and some of them, in a shopping cart, into section B at the Azura Bowl.'],
      ['marguerite', 'What do I owe you, Mister Ketch?'],
      ['sam', 'Fifty a day, and one duck.'],
      ['sam', "She left, and the rain stopped, for once. I put the duck on my desk, next to the burrito. Real ducks come home, they say. So do rubber ones, if you wait long enough and nobody's paying you to find them."],
      ['announcer', "Next time on Harbor Lights: chapter one. We've only got the five."],
    ],
  },

  // Underwriting, read by Marjorie. Morty Fenwick's goes on from one break to the next.
  {
    id: 'sapr-ad-morty',
    kind: 'ad',
    series: 'sapr-morty',
    part: 1,
    lines: [
      ['marjorie', 'SAPR is supported by Morty Fenwick, attorney at law, and by listeners like you, who Morty reminds have the right to remain silent.'],
      ['marjorie', 'Morty Fenwick. Technically, a lawyer.'],
    ],
  },
  {
    id: 'sapr-ad-morty-bail',
    kind: 'ad',
    series: 'sapr-morty',
    part: 2,
    lines: [
      ['marjorie', 'SAPR is supported by Morty Fenwick, attorney at law, who is currently a guest of SAPD Central, and by listeners like you, who could post his bail.'],
      ['marjorie', 'He has asked us to read that part twice. Listeners like you could post his bail.'],
    ],
  },
  {
    id: 'sapr-ad-mutual',
    kind: 'ad',
    lines: [
      ['marjorie', 'SAPR is supported by Azura Mutual Insurance, who would like to remind listeners that Harbor Lights is a work of fiction, and that any resemblance to any container, sunk or floating, is a coincidence.'],
      ['marjorie', "Azura Mutual. We're probably there for you."],
    ],
  },
  {
    id: 'sapr-ad-salgado',
    kind: 'ad',
    lines: [
      ['marjorie', 'SAPR is supported by the Hotel Salgado, on Ocean Beach. Thick walls, discreet staff, and a night manager who has never once seen anything.'],
      ['marjorie', 'The Hotel Salgado. Rooms by the night, by the week, or by arrangement.'],
    ],
  },

  // Station idents, played over the jingle's bells.
  { id: 'sapr-ident-calm', kind: 'ident', lines: [['marjorie', 'SAPR, one oh seven point three. San Azura Public Radio. Calm voices. Pledge now.']] },
  { id: 'sapr-ident-reginald', kind: 'ident', lines: [['reginald', "This is Reginald Ashcombe-Pryce. You are listening to SAPR, one oh seven point three. I'm so sorry."]] },
  { id: 'sapr-ident-pru', kind: 'ident', lines: [['pru', "Pru here. You're listening to SAPR, one oh seven point three. Water deeply, and ask no questions."]] },
  { id: 'sapr-ident-sam', kind: 'ident', lines: [['sam', 'The name is Ketch. The station is SAPR, one oh seven point three. The rain is free.']] },
];

/** Reginald reads at his own pace, wherever he is heard. */
const paced = (l: Line): Line => (l[0] === 'reginald' ? [l[0], l[1], { speed: 0.92, ...l[2] }] : l);

export const SAPR: readonly TalkPiece[] = PIECES.map((p) => ({ ...p, show: 'sapr', lines: p.lines.map(paced) }));
