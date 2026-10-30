// THE BOWL 1090 AM: sports talk about the San Azura Gulls, twelve games without a win. Big Ron Tackett, nine years on
// the Gulls' line, takes the calls; Nate "Numbers" Pruitt has the injury report and the scores; Nigel Pembury, the
// coach from England, still coaches the other football. Sal from Southgate calls every night.

import type { TalkPiece } from '../script';

const PIECES: readonly TalkPiece[] = [
  // Big Ron at the microphone.
  {
    id: 'bowl-host-kicker',
    kind: 'host',
    lines: [
      ['ron', "Big Ron Tackett, The Bowl, ten ninety AM. I played nine years on the Gulls' line. I have seen kicks blocked, kicks shanked, kicks that hit the upright and fell in anyway."],
      ['ron', "Sunday I watched our kicker miss the ball. Not the posts, San Azura. The ball. It was on a tee. It was the only thing on that field under no pressure at all."],
      ['ron', "And he looked down at his foot like it owed him money. Lars. The foot is fine. The foot showed up."],
    ],
  },
  {
    id: 'bowl-host-ducks',
    kind: 'host',
    lines: [
      ['ron', "Let's talk about the ducks. Ten thousand rubber ducks go missing at the docks, they've been washing up on Ocean Beach all week, and Sunday, in the fourth quarter, they all came flying out of the stands."],
      ['ron', "Down forty two to three, and it's raining rubber ducks. The refs stopped the game for eleven minutes. Best eleven minutes of the season."],
      ['ron', "And Nate ran the numbers. The ducks had a better completion rate. Every one of those ducks reached the field. Our quarterback can't say that."],
    ],
  },
  {
    id: 'bowl-host-streak',
    kind: 'host',
    lines: [
      ['ron', "Twelve straight losses. My doctor told me to stop watching the Gulls, for my heart. I said, doc, my heart left in week four. It's staying with its sister."],
      ['ron', "The club says this is a rebuilding era. You know what you need for a rebuild? Something that was built. This is not a rebuild. This is a vacant lot with a scoreboard."],
      ['ron', "And the scoreboard still spells home with two m's. It's the one thing in that stadium you can count on."],
    ],
  },
  {
    id: 'bowl-host-pettibone',
    kind: 'host',
    lines: [
      ['ron', "Brock Pettibone. Our quarterback. Our franchise. A man with a cannon for an arm, and no idea where the cannon is pointed."],
      ['ron', "Four interceptions on Sunday. The other team's safety has caught more of Brock's passes this year than our receivers. He sent Brock a fruit basket. With a card. It said, same time next year."],
      ['ron', "I'm not saying bench him. I'm saying the bench has better vision, and the bench has never thrown one to the other team."],
    ],
  },
  {
    id: 'bowl-host-mascot',
    kind: 'host',
    lines: [
      ['ron', "A lot of you are asking about Squawk. Our mascot, the big seagull, has missed three straight games, and the club will only say he is out indefinitely, pending the investigation."],
      ['ron', "Here's what I know. After the forty two to three, Squawk was seen in the car park, having words with the Canyon City mascot, a grown man dressed as a cactus."],
      ['ron', "Nobody will say who threw the first wing. I'll say this. The cactus had spikes, Squawk had a beak, and I still had money on the bird."],
    ],
  },
  {
    id: 'bowl-host-coach',
    kind: 'host',
    lines: [
      ['ron', "Let's talk about the coach. Nigel Pembury came to us from England, where he coached the other football, the round one. Folks, I don't think anybody told him."],
      ['ron', "At halftime he pulled the whole offensive line for using their hands. He wants the punter to put it in the top corner. He keeps asking the refs where the goalkeeper is."],
      ['ron', "Nigel. There's no corner. There's no keeper. There's a post shaped like a fork, and right now it's the best player on the field."],
    ],
  },

  // Callers.
  {
    id: 'bowl-call-sal-coach',
    kind: 'call',
    lines: [
      ['ron', "Sal from Southgate, you're on The Bowl."],
      ['sal', "Ron. Fire the coach."],
      ['ron', "Sal, the coach is your brother-in-law."],
      ['sal', "That's how I know."],
      ['ron', "You had him over for dinner on Sunday."],
      ['sal', "He passed me the potatoes with his feet, Ron. With his feet. My mother was there."],
      ['ron', "Sal, that's how they do it in England."],
      ['sal', "Then send him back to England. I'll hang up and listen."],
    ],
  },
  {
    id: 'bowl-call-sal-seat',
    kind: 'call',
    lines: [
      ['ron', "Line three, it's Sal from Southgate again. Sal, that's twice this week."],
      ['sal', "Ron, I've had season tickets for thirty one years. Section B, row two. I have seen every loss."],
      ['ron', "That's a lot of losses, Sal."],
      ['sal', "Sunday they moved me. Right behind the Gulls bench. Ron, I could hear them calling the plays."],
      ['ron', "And?"],
      ['sal', "And I want my old seat back. I was happier when I thought there was a plan."],
    ],
  },
  {
    id: 'bowl-call-sal-ducks',
    kind: 'call',
    lines: [
      ['ron', "Sal, the stadium says somebody brought four hundred rubber ducks into section B on Sunday."],
      ['sal', "I don't know nothing about that."],
      ['ron', "Section B, Sal. Your section."],
      ['sal', "Lot of people sit in section B, Ron."],
      ['ron', "The cameras show a man in a Gulls jacket pushing a shopping cart full of ducks up the stairs."],
      ['sal', "They were on the beach, Ron. Free ducks. The ocean was giving them away. What was I supposed to do, leave them?"],
    ],
  },
  {
    id: 'bowl-call-velora',
    kind: 'call',
    lines: [
      ['ron', "Vince, you're on The Bowl."],
      ['vince', "Ron, first time on a sports show. Somebody stole my Velora outside the bank, and Sunday I find it in the stadium car park. Tailgating."],
      ['ron', "Tailgating?"],
      ['vince', "Four guys grilling hot dogs off my back bumper, Ron."],
      ['ron', "Did you get it back?"],
      ['vince', "No. They gave me a hot dog. Honestly, very good hot dog. A little cinnamon in there, from the air freshener."],
    ],
  },
  {
    id: 'bowl-call-tacos',
    kind: 'call',
    lines: [
      ['ron', "Marcus, go ahead."],
      ['marcus', "Ron, I park my taco truck outside the Azura Bowl on game days, and I sell more tacos in the third quarter than at kickoff."],
      ['ron', "Why's that?"],
      ['marcus', "Nobody stays for the fourth, Ron. They come out at the half, eat their feelings and go home. So I named a burrito after the offense."],
      ['ron', "What's in it?"],
      ['marcus', "Nothing, man. It's a tortilla. It doesn't go anywhere either."],
    ],
  },
  {
    id: 'bowl-call-gary',
    kind: 'call',
    lines: [
      ['ron', "Gary from the Westside. Gary, this is a sports show."],
      ['gary', "Ron, I know what I saw. Nobody loses twelve straight by accident. The Gulls are being paid to lose."],
      ['ron', "Paid by who, Gary?"],
      ['gary', "Follow the money, Ron. Who profits when the Gulls lose?"],
      ['ron', "Nobody, Gary. Nobody has ever made a dime off the Gulls. It's the one thing we know for sure."],
      ['gary', "Exactly. The perfect cover."],
    ],
  },
  {
    id: 'bowl-call-paint',
    kind: 'call',
    lines: [
      ['ron', "Linda in Hillcrest, you're on The Bowl."],
      ['linda', "Ron, my husband paints his face teal and white for every Gulls game, and he swore he won't wash it off until they win."],
      ['ron', "That's a real fan, Linda."],
      ['linda', "It's been twelve weeks, Ron. He went to a job interview like that."],
      ['ron', "Did he get the job?"],
      ['linda', "He did. They thought he was the mascot. They've been looking for Squawk."],
    ],
  },

  // The sports desk.
  {
    id: 'bowl-news-injuries',
    kind: 'news',
    lines: [
      ['nate', "Nate Pruitt with the Gulls injury report. Quarterback Brock Pettibone, probable, with a sore arm from waving at the other team's fans."],
      ['nate', "Kicker Lars Lindqvist, healthy, which the coaching staff describes as the real problem."],
      ['nate', "And the entire offensive line is listed as day to day, which, to be fair, is also how they play."],
    ],
  },
  {
    id: 'bowl-news-squawk',
    kind: 'news',
    lines: [
      ['nate', "Updating the injury report. Squawk the mascot, out indefinitely, pending the investigation."],
      ['nate', "Running back Duke Slocum, out, with a hamstring he pulled running away from a tackle. Our own linebacker, at practice. He panicked."],
      ['nate', "And the Gulls playbook is listed as missing. Police found it in a trash can outside the stadium and returned it. The coach thanked them and put it back."],
    ],
  },
  {
    id: 'bowl-news-scores',
    kind: 'news',
    lines: [
      ['nate', "Around the league. The Canyon City Cacti, thirty one, the Bayview Clams, twenty eight. The Northgate Possums, seventeen, the Ridgeback Moose, fourteen. And the Gulls had a bye week, and lost it."],
      ['ron', "Nate, how do you lose a bye week?"],
      ['nate', "They booked a scrimmage with the Azura High junior varsity, Ron. Twenty one to six."],
      ['ron', "The kids won?"],
      ['nate', "The kids won. They gave the Gulls the game ball, to be nice. We fumbled it on the way to the bus."],
    ],
  },
  {
    id: 'bowl-news-presser',
    kind: 'news',
    lines: [
      ['nate', "Gulls coach Nigel Pembury spoke to reporters after the forty two to three. Here's the tape."],
      ['pembury', "Look, disappointing result. The lads gave everything. We had a plan. The plan was to kick it."],
      ['nate', "Coach, your team had the ball for six minutes."],
      ['pembury', "And that's the problem, isn't it. Far too many hands on it. Back home you'd be sent off for that."],
      ['nate', "Coach, do you know it's a different sport?"],
      ['pembury', "I know the pitch is the wrong shape, if that's what you're asking. Cheers, everyone. Lovely."],
    ],
  },

  // Ads only THE BOWL runs (it also carries Bang Bang Guns, the Thunderhoof, Torque and Morty Fenwick, script.ts).
  {
    id: 'bowl-ad-tickets',
    kind: 'ad',
    lines: [
      ['announcer', "The San Azura Gulls are back, and so are you, because you already paid. Season tickets are on sale now. Twelve home games, and every seat has a view of the scoreboard, the one thing in the stadium that moves."],
      ['announcer', "Gulls season tickets. Now cheaper than parking. Parking sold separately, and honestly, it's the better deal."],
    ],
  },
  {
    id: 'bowl-ad-thunderhoof',
    kind: 'ad',
    lines: [
      ['announcer', "The Thunderhoof. Official truck of the Gulls car park, where it spends the whole game, because the game is not worth walking in for."],
      ['announcer', "The tailgate holds a grill, a cooler and six grown men who have stopped believing. The Thunderhoof. Still there in the fourth quarter. Unlike the fans."],
    ],
  },
  {
    id: 'bowl-ad-guns',
    kind: 'ad',
    lines: [
      ['ron', "Folks, Big Ron here for my friends at Bang Bang Guns, in Southgate and on the Westside. Official sponsor of the Gulls defense, which explains a lot. They've been shooting themselves in the foot all year."],
      ['ron', "I go in there, they know my name. They don't ask questions, which after Sunday, I appreciate. Bang Bang Guns. Tell them Ron sent you. Don't bring up the Gulls."],
    ],
  },

  // Station idents, played over the jingle's bells.
  { id: 'bowl-ident-hope', kind: 'ident', lines: [['announcer', 'The Bowl, ten ninety AM. Where hope comes to lose.']] },
  { id: 'bowl-ident-wins', kind: 'ident', lines: [['announcer', "You're listening to The Bowl, ten ninety AM. All sports. No wins."]] },
  { id: 'bowl-ident-ron', kind: 'ident', lines: [['ron', "This is Big Ron Tackett. The Bowl, ten ninety AM. We lose, so you don't have to."]] },
  { id: 'bowl-ident-sal', kind: 'ident', lines: [['sal', "This is Sal from Southgate, and The Bowl is the only station I trust. Fire the coach."]] },
  { id: 'bowl-ident-pembury', kind: 'ident', lines: [['pembury', "Nigel Pembury here. You're listening to The Bowl, ten ninety AM, the home of proper football."]] },
];

export const BOWL: readonly TalkPiece[] = PIECES.map((p) => ({ ...p, show: 'bowl' }));
