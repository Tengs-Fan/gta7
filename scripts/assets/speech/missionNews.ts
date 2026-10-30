// What the Azura Newsdesk reports of Kai's missions (newsroom.ts reads it when one is passed): what the city saw, as
// Dolores Vance would put it, never what only Kai knows. A follow-up airs a game day or more later. Each piece is one
// clip, its sentences read one after another; build.ts renders them as news-m-<id> and news-m-<id>-later.

/** The breaking piece and the follow-up of each mission, by MissionDef id, sentence by sentence. */
export const MISSION_NEWS: Readonly<Record<string, { breaking: readonly string[]; followUp?: readonly string[] }>> = {
  wheels: {
    breaking: ['Police report another car theft in San Azura today.', 'The car was last seen heading into the Port Azura Docks at exactly the speed limit, which officers found deeply suspicious.'],
    followUp: ['The owner of the car stolen at the docks yesterday has asked the thief to at least return his sunglasses.', 'Police say they have one lead: a woman at the docks who calls everybody baby.'],
  },
  delivery: {
    breaking: ['A parcel vanished from a Midtown parking lot today, and turned up minutes later in Hillcrest, in the hands of a very nervous man.', 'Police say the parcel was not, quote, cookies.'],
    followUp: ['The nervous man from Hillcrest has moved away.', 'His neighbors describe him as polite, sweaty, and in a hurry.'],
  },
  repo: {
    breaking: ['Shots were fired in Westside today, as a red Nightjar GT was driven away from under the noses of the Tiburones.', 'The gang has declined to report it stolen, for reasons.'],
    followUp: ['The Tiburones are offering a reward for the return of their red Nightjar.', 'No questions asked, they say, and then a lot of questions.'],
  },
  loose_lips: {
    breaking: ['Benny Two-Tone, a well known man about town, was on his way to SAPD Central today with a notebook.', 'He never arrived, and has not been seen since.', 'Police would very much like to read that notebook.'],
    followUp: ["Police have found Benny Two-Tone's notebook.", 'It contains a shopping list, and the word sorry, underlined twice.'],
  },
  heatwave: {
    breaking: ['Three vans burned in three different neighborhoods today.', 'Fire crews say the vans belonged to the Tiburones, and the smoke smelled, quote, expensive.'],
    followUp: ['The Tiburones say the three vans that burned yesterday were full of blankets for orphans.', 'The orphans could not be reached for comment.'],
  },
  big_score: {
    breaking: ['The First Azura Bank was robbed today.', 'Witnesses say the robbers escaped to the Marina, by boat.'],
    followUp: ['The First Azura Bank reopened today, with a second lock and a very large dog.', 'Police say the dog has already been bribed.'],
  },
  shadow_play: {
    breaking: ['A Tiburones courier was seen making a delivery today, to a man in a very familiar uniform.', 'The SAPD says it is, quote, not what it looks like.'],
    followUp: ['The SAPD says the officer seen with a Tiburones courier was working undercover.', 'The department has not said which side he was undercover for.'],
  },
  room_service: {
    breaking: ['Gunfire outside Hotel Salgado today, as a crowd of Tiburones tried to check in without a reservation.', 'The hotel says not one of them made it past the front door.'],
    followUp: ['Hotel Salgado now has five stars from its guests.', 'They praise the friendly staff, and the very strict door policy.'],
  },
  showroom: {
    breaking: ['A yellow Nightjar GT was stolen today, and driven across town without a single scratch.', 'Not one red light was run. Police are baffled.'],
    followUp: ['The owner of the yellow Nightjar says he is heartbroken, and also impressed.', 'He says it has never been driven that nicely, even by him.'],
  },
  off_the_road: {
    breaking: ['A very large truck ran two cars off the road today, and witnesses report envelopes of cash blowing down the street.', 'Police ask anyone who picked one up to, quote, think about what you have done.'],
    followUp: ['Police say the cash found on the road is now safely in evidence.', 'Most of it.'],
  },
  rush_hour: {
    breaking: ['A Thunderhoof was clocked at twice the speed limit through three neighborhoods today, stopping only to pick up envelopes.', 'Police believe the driver works for the post office, and they are filing a complaint.'],
  },
  last_call: {
    breaking: ['An SAPD sergeant has left the country.', 'The department says there was never a ledger, and please stop asking about the ledger.'],
    followUp: ['The sergeant who left the country has sent the department a postcard.', 'It says, wish you were here, but not really.'],
  },
};
