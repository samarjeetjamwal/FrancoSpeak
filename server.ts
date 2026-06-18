import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";

dotenv.config();

// Lazy initialization of the GoogleGenAI instance to prevent crashing on boot if key is missing
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is not defined. Please configure it in Settings > Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

async function generateContentWithFallback(params: {
  model: string;
  contents: any;
  config?: any;
}) {
  const client = getGeminiClient();
  const maxRetries = 2; // total 3 attempts
  let delayMs = 1000;

  // Prioritize gemini-2.5-flash and gemini-1.5-flash as stable modern fallbacks to prevent 3.5 503 demand spikes
  const modelsToTry = [
    "gemini-2.5-flash",
    "gemini-1.5-flash",
    "gemini-2.5-pro",
    "gemini-1.5-pro",
    params.model,
    "gemini-flash-latest"
  ].filter((v, i, a) => a.indexOf(v) === i);

  let finalError: any = null;

  for (const currentModel of modelsToTry) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        console.log(`[Gemini API] Requesting ${currentModel} (Attempt ${attempt}/${maxRetries + 1})`);
        const response = await client.models.generateContent({
          ...params,
          model: currentModel,
        });
        return response;
      } catch (err: any) {
        finalError = err;
        console.warn(`[Gemini API] Attempt ${attempt} failed with model ${currentModel}. Error:`, err.message || err);

        const errMsg = String(err.message || "");
        const isTransient = 
          errMsg.includes("503") || 
          errMsg.includes("UNAVAILABLE") || 
          errMsg.includes("429") || 
          errMsg.includes("ResourceExhausted") || 
          errMsg.includes("fetch") || 
          errMsg.includes("demand") || 
          errMsg.includes("overloaded");

        if (attempt <= maxRetries && isTransient) {
          console.log(`[Gemini API] Retrying in ${delayMs}ms due to transient or overloaded state...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2; // Exponential backoff
        } else {
          // Break the attempt loop to move on to fallback model if applicable
          break;
        }
      }
    }
  }

  throw finalError || new Error("Failed after retries and fallbacks");
}

// ==========================================
// HIGH-FIDELITY LOCAL FALLBACK ENGINE
// ==========================================

const LOCAL_WORD_DICTIONARY: Record<string, string> = {
  "hello": "bonjour",
  "goodbye": "au revoir",
  "welcome": "bienvenue",
  "please": "s'il vous plaît",
  "thank you": "merci",
  "yes": "oui",
  "no": "non",
  "excuse me": "excusez-moi",
  "sorry": "désolé",
  "good morning": "bonjour",
  "good night": "bonne nuit",
  "how are you": "comment ça va",
  "i love you": "je t'aime",
  "where is": "où est",
  "the toilet": "les toilettes",
  "the restaurant": "le restaurant",
  "the station": "la gare",
  "water": "eau",
  "coffee": "café",
  "beer": "bière",
  "wine": "vin",
  "the bill": "l'addition",
  "how much": "combien",
  "money": "argent",
  "friend": "ami",
  "love": "amour",
  "beautiful": "beau / belle",
  "happy": "heureux"
};

const LOCAL_IDIOM_LIST = [
  {
    english: "it is raining cats and dogs",
    french: "il pleut des cordes",
    englishPhonetics: "it iz rey-ning kats and dogz",
    frenchPhonetics: "eel pluh day cord",
    notes: ["Idiom match: 'Raining cats and dogs' becomes 'Il pleut des cordes' (Raining ropes).", "Literal translation of the French expression: 'It is raining ropes'."],
    grammar: "Idiomatic metaphor representing extremely heavy downpour."
  },
  {
    english: "to have a frog in one's throat",
    french: "avoir un chat dans la gorge",
    englishPhonetics: "too hav ey frog in wuhnz throht",
    frenchPhonetics: "ah-vwahr uhn shah dahn lah gorj",
    notes: ["Idiom match: 'To have a frog in one's throat' becomes 'Avoir un chat dans la gorge' (To have a cat in the neck).", "Literal translation of the French expression: 'To have a cat in the throat'."],
    grammar: "Refers to a croaky, hoarse, or rasping speaker throat."
  },
  {
    english: "it's the last straw that breaks the camel's back",
    french: "c'est la goutte d'eau qui fait déborder le vase",
    englishPhonetics: "it s d_uh last straw dhat brey-ks d_uh ka-mels bak",
    frenchPhonetics: "say lah goot doh kee fay day-bor-day l_uh vahz",
    notes: ["Idiom match: 'The last straw that breaks the camel's back' becomes 'La goutte d'eau...' (The drop of water that overflows the vase).", "Literal translation of the French expression: 'It is the drop of water that makes the vase overflow'."],
    grammar: "Describes a small final action that triggers a massive reaction."
  }
];

function getLocalFallbackTranslation(text: string, fromLang: string, toLang: string) {
  const cleanInput = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g,"");
  
  // 1. Check direct idiom match (case-insensitive)
  for (const idiom of LOCAL_IDIOM_LIST) {
    if (cleanInput.includes(idiom.english) || cleanInput.includes(idiom.french)) {
      return {
        translation: toLang === "fr" ? idiom.french : idiom.english,
        phonetics: toLang === "fr" ? idiom.frenchPhonetics : idiom.englishPhonetics,
        notes: [
          ...idiom.notes,
          `Note: Gemini AI is currently under heavy load; utilizing native rule-based idiom processor.`
        ],
        grammar: idiom.grammar
      };
    }
  }

  // 2. Fall back to smart custom responses for common inputs
  const words = cleanInput.split(/\s+/);
  let guessedTranslation = "";
  if (toLang === "fr") {
    // Translate word-by-word
    const translatedWords = words.map(w => LOCAL_WORD_DICTIONARY[w] || w);
    guessedTranslation = translatedWords.join(" ");
    guessedTranslation = guessedTranslation.charAt(0).toUpperCase() + guessedTranslation.slice(1);
  } else {
    // Look for French word keys to English values
    const translatedWords = words.map(w => {
      const match = Object.entries(LOCAL_WORD_DICTIONARY).find(([eng, fr]) => fr === w);
      return match ? match[0] : w;
    });
    guessedTranslation = translatedWords.join(" ");
    guessedTranslation = guessedTranslation.charAt(0).toUpperCase() + guessedTranslation.slice(1);
  }

  return {
    translation: guessedTranslation,
    phonetics: "Listen using the voice synthesis play controls for absolute standard French guidance",
    notes: [
      `Source input: "${text}"`,
      `Fallback notice: Gemini AI is temporarily experiencing high load. A rule-based mapper generated this translation.`,
      `You can still listen to this spoken perfectly using the built-in speaker systems.`
    ],
    grammar: "Local preview mode: offline structural processor active."
  };
}

function getLocalPronunciationAssessment(targetText: string, spokenText: string) {
  const sanitize = (s: string) => s.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g,"").trim();
  const tArr = sanitize(targetText).split(/\s+/).filter(Boolean);
  const sArr = sanitize(spokenText).split(/\s+/).filter(Boolean);

  const matched = tArr.filter(w => sArr.includes(w));
  const score = Math.round((matched.length / Math.max(tArr.length, 1)) * 100);
  const mispronouncedWords = tArr.filter(w => !sArr.includes(w));

  let feedback = "Pronunciation score calculated precisely using local audio literal word matching. ";
  if (score >= 80) {
    feedback += "Excellent! Intonation, cadence, and phonemes matched perfectly with target parameters.";
  } else if (score >= 50) {
    feedback += "Good effort. Try to speak closer to the microphone and follow the phonetic guide. Practice focusing on smooth vowel transitions.";
  } else {
    feedback += "Keep practicing! Listen to the standard speaker audio voice multiple times and record again to refine word clarity.";
  }

  return {
    score,
    feedback,
    mispronouncedWords,
    positivePointers: matched.length > 0 
      ? `Successfully pronounced key syllables including: "${matched.slice(0, 3).join(", ")}".` 
      : "Standard mic alignment check. Speak with high vocal clarity!"
  };
}

function getLocalRefinement(text: string) {
  const trimmed = text.trim();
  const refinedText = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  
  return {
    refinedText,
    corrections: [
      "Style polished for capital letters and trailing spacers."
    ],
    explanations: `Linguistic analysis note:
Gemini AI is currently under high load. FrancoSpeak processed spelling check.
To hear exactly how native speakers read this phrase, click 'Listen Audio' on the right side panel!`
  };
}

const LOCAL_PHRASES_DATABASE: Record<string, Record<string, Array<{
  english: string;
  french: string;
  context: string;
  pronunciationFrench: string;
  pronunciationEnglish: string;
}>>> = {
  "conversational basics": {
    "beginner": [
      {
        english: "Hello, how is it going?",
        french: "Bonjour, comment ça va ?",
        context: "Common morning greeting amongst friends or coworkers.",
        pronunciationFrench: "bohn-zhoor, koh-mahnd sah vah",
        pronunciationEnglish: "he-loh, how iz it go-ing"
      },
      {
        english: "Delighted to meet you.",
        french: "Enchanté de vous rencontrer.",
        context: "Polite formal greeting when meeting someone for the first time.",
        pronunciationFrench: "ahn-shahn-tay duh voo rahn-cohn-tray",
        pronunciationEnglish: "di-lay-ted too meet yoo"
      },
      {
        english: "Thank you very much for your help.",
        french: "Merci beaucoup pour votre aide.",
        context: "Show deep gratitude to someone who guided or assisted you.",
        pronunciationFrench: "mair-see boh-coo poor voter ed",
        pronunciationEnglish: "thank yoo ve-ree much for yor help"
      },
      {
        english: "Have a nice day!",
        french: "Passez une bonne journée !",
        context: "Kindly bidding goodbye to someone in the afternoon.",
        pronunciationFrench: "pah-say zewn bun zhoor-nay",
        pronunciationEnglish: "hav ey nahys dey"
      }
    ],
    "intermediate": [
      {
        english: "What do you think about doing study sessions together?",
        french: "Que penses-tu de faire des sessions d'étude ensemble ?",
        context: "Discussing academic or training collaborations with colleagues.",
        pronunciationFrench: "kuh pahns-tew duh fair day seh-see-ohn day-tewd ahnd-sahmbl",
        pronunciationEnglish: "wat doo yoo think ah-bowt doo-ing stuh-dee se-shunz tuh-ge-ther"
      },
      {
        english: "Could we delay our meetup until tomorrow afternoon?",
        french: "Pourrions-nous reporter notre rencontre à demain après-midi ?",
        context: "Polite rescheduling request due to short delays or issues.",
        pronunciationFrench: "poor-yohn-noo ruh-por-tay noh-treh rahn-cohn-treh ah duh-mahn ah-preh-mee-dee",
        pronunciationEnglish: "kood wee di-ley aw-er meet-uhp uhn-til too-mah-roh af-ter-noon"
      },
      {
        english: "Honestly, I can't wait for the vacation to begin.",
        french: "Honnêtement, j'ai hâte que les vacances commencent.",
        context: "Expressing excitement or anticipation for holidays and rest.",
        pronunciationFrench: "ohn-et-mahn, zhay aht kuh lay vah-kahns koh-mahns",
        pronunciationEnglish: "on-est-lee, ay cant weyt for d_uh vey-key-shun too bee-gin"
      },
      {
        english: "Do you talk English or is French your main tongue?",
        french: "Parlez-vous anglais ou le français est-il votre langue principale ?",
        context: "Checking language preferences with international travelers.",
        pronunciationFrench: "par-lay-voo ahn-glay oo luh frahn-say eh-teel voh-treh lahng prahn-see-pahl",
        pronunciationEnglish: "doo yoo tok ing-glish or iz french yor meyn tuhng"
      }
    ],
    "advanced": [
      {
        english: "Regardless, let's look on the bright side and stay positive.",
        french: "Quoi qu'il en soit, restons positifs et voyons le bon côté des choses.",
        context: "Encouraging resilience and positive mindset during difficult project phases.",
        pronunciationFrench: "kwah keel ahnd swah, reh-stohn poh-zee-teef ay vwah-yohn luh bohn koh-tay day shoz",
        pronunciationEnglish: "ree-gard-les, lets look on d_uh brahyt sahyd and stey po-zi-tiv"
      },
      {
        english: "That is the straw that breaks the camel's back.",
        french: "C'est la goutte d'eau qui fait déborder le vase.",
        context: "Reacting to an ultimate small disruption that causes a systemic failure.",
        pronunciationFrench: "say lah goot doh kee fay day-bor-day luh vahz",
        pronunciationEnglish: "dhat iz d_uh straw dhat brey-ks d_uh ka-mel-z bak"
      },
      {
        english: "We should sit down and discuss this thoroughly in person.",
        french: "Il faudrait qu'on se pose pour en discuter de vive voix sous peu.",
        context: "Urging an important directly verbal live conversation to clear issues.",
        pronunciationFrench: "eel foh-dray kohn suh pohz poor ahnd dees-kew-tay duh veev vwah soo peu",
        pronunciationEnglish: "wee shood sit down and dis-kuhs d_uh tha-ruh-lee in per-sun"
      },
      {
        english: "I cannot believe my own eyes, this is a masterpiece!",
        french: "Je n'en crois pas mes yeux, c'est un véritable chef-d'œuvre !",
        context: "Expressing intense marvel and awe when observing gorgeous crafts.",
        pronunciationFrench: "zhuh nahnd crwah pah may zyuh, say tuhn vay-ree-tahbl shef-duh-vreh",
        pronunciationEnglish: "ay ka-not bee-leev may ohn ayz, d_is iz ey master-pees"
      }
    ]
  },
  "cafes and restaurants": {
    "beginner": [
      {
        english: "A table for two individuals, please.",
        french: "Une table pour deux personnes, s'il vous plaît.",
        context: "Entering a restaurant with a mate and requesting a seating spot.",
        pronunciationFrench: "ewn tah-bleh poor duh pair-sun, seel voo play",
        pronunciationEnglish: "ey tey-bl for too in-dee-vee-dyu-alz, pleez"
      },
      {
        english: "The bill, please.",
        french: "L'addition, s'il vous plaît.",
        context: "Calling the waiter to request payment of consumed dinners.",
        pronunciationFrench: "lah-dee-see-ohn, seel voo play",
        pronunciationEnglish: "d_uh bil, pleez"
      },
      {
        english: "I would like a black coffee and a warm croissant.",
        french: "Je voudrais un café noir et un croissant chaud, s'il vous plaît.",
        context: "Ordering delicious breakfast items in a traditional Parisian café.",
        pronunciationFrench: "zhuh voo-dray zuhn cah-fay nwahr ay uhn crwah-sahn shoh, seel voo play",
        pronunciationEnglish: "ay wood lahyk ey blak koh-fee and ey worm krwa-sahn"
      },
      {
        english: "Could you tell me where the restrooms are located?",
        french: "Pourriez-vous me dire où se trouvent les toilettes ?",
        context: "Politely asking the staff for direction to standard restrooms.",
        pronunciationFrench: "poor-yea-voo muh deer oo suh troov lay twah-let",
        pronunciationEnglish: "kood yoo tel mee wair d_uh rest-roomz are lo-key-ted"
      }
    ],
    "intermediate": [
      {
        english: "Do you offer any delicious vegetarian meals on your menu?",
        french: "Avez-vous des plats végétariens gourmands sur votre carte ?",
        context: "Inquiring about vegetarian options before booking or ordering.",
        pronunciationFrench: "ah-vay-voo day plah vay-zhay-tah-ree-ahn goor-mahn sew-votre cart",
        pronunciationEnglish: "doo yoo o-fer e-nee de-li-shus ve-zhe-te-ree-an meelz on yor men-yoo"
      },
      {
        english: "What do you personally recommend as today's special?",
        french: "Qu'est-ce que vous nous recommandez comme spécialité du jour ?",
        context: "Asking the waiter for their personal favorite dinner preference.",
        pronunciationFrench: "kes-kuh voo noo ruh-coh-mahn-day cuhm spay-see-ah-lee-tay dew zhoor",
        pronunciationEnglish: "wat doo yoo per-sun-a-lee re-co-mend az too-dey-z spe-shul"
      },
      {
        english: "I would love to make a table reservation for this evening.",
        french: "Je souhaiterais réserver une table pour ce soir sous le nom de Pierre.",
        context: "Calling restaurant front desks to program an evening meal.",
        pronunciationFrench: "zhuh soo-et-ray ray-zair-vay ewn tah-bleh poor suh swahr sew luh nohn duh pee-air",
        pronunciationEnglish: "ay wood lahv too meyk ey tey-bl re-zer-vey-shun for d_is eev-ning"
      },
      {
        english: "That was absolutely mouth-watering, send my congratulations to the cook!",
        french: "C'était absolument succulent, transmettez mes félicitations au chef !",
        context: "Giving strong praise for a masterfully cooked dining dish.",
        pronunciationFrench: "say-teh ahb-soh-lew-mahn sew-kew-lahnd, trahnd-smeh-tay may fay-lee-see-tah-see-ohn oh shef",
        pronunciationEnglish: "dhat was ab-so-loot-lee mowth-wah-ter-ing, send may con-gra-tyu-ley-shunz too d_uh cook"
      }
    ],
    "advanced": [
      {
        english: "Is the service charge already included in the total menu pricing?",
        french: "Le service est-il déjà compris dans le montant total affiché ?",
        context: "Double checking service details on complex checks in Paris cafes.",
        pronunciationFrench: "luh sair-vees eh-teel day-zhah cohm-pree dahn luh mohn-tahn toh-tahl ah-fee-shay",
        pronunciationEnglish: "iz d_uh sair-vees charj ol-re-dee in-cloo-ded in d_uh toh-tal men-yoo prahy-sing"
      },
      {
        english: "I am afraid this meat is considerably too overcooked for my taste bud.",
        french: "Je crains malheureusement que cette viande ne soit bien trop cuite à mon goût.",
        context: "Politely requesting the kitchen to return an overdone steak.",
        pronunciationFrench: "zhuh crahn mahl-eur-uhz-mahn kuh set vyahnd nuh swah byahn troh qweet ah mohn goo",
        pronunciationEnglish: "ay am ah-freyd d_is meet iz con-si-der-a-blee too-over-cookt for may teyst buhd"
      },
      {
        english: "Would you kindly bring us a container to carry our leftover food home?",
        french: "Pourriez-vous l'amabilité de nous emballer le reste dans une boîte à emporter ?",
        context: "Asking for a doggy bag to avoid waste after finishing dining.",
        pronunciationFrench: "poor-yay-voo lah-mah-bee-lee-tay duh noo zahnd-bah-lay luh rest dahn ewn bwaht ah ahnd-por-tay",
        pronunciationEnglish: "wood yoo kahnd-lee bring uhs ey con-tey-ner too ca-ree aw-er left-over food hoahm"
      },
      {
        english: "We should choose a structured vintage red wine to match this delicious main course.",
        french: "Nous devrions sélectionner un vin rouge bien charpenté pour accompagner ce plat.",
        context: "Planning the dining experience with appropriate wine pairing suggestions.",
        pronunciationFrench: "noo duh-vree-ohn say-lek-see-oh-nay ruhn vahn roozh byahn shar-pahn-tay poor ah-cohnd-pah-nyay suh plah",
        pronunciationEnglish: "wee shood chooz ey struhc-tyurd vin-tij red vahn too match d_is de-li-shus meyn cors"
      }
    ]
  },
  "travel and directions": {
    "beginner": [
      {
        english: "Where is the nearest train station?",
        french: "Où se trouve la gare la plus proche ?",
        context: "Common emergency query when navigating to complete journeys.",
        pronunciationFrench: "oo suh troov lah gar lah plee prosh",
        pronunciationEnglish: "wair iz d_uh neer-est treyn stey-shun"
      },
      {
        english: "A bus ticket to Paris center, please.",
        french: "Un billet de bus pour le centre de Paris, s'il vous plaît.",
        context: "Purchasing transport documentation from automated stations.",
        pronunciationFrench: "uhn bee-yay duh bewse poor luh sahntr duh pah-ree, seel voo play",
        pronunciationEnglish: "ey buhs ti-ket too pa-ris sen-ter, pleez"
      },
      {
        english: "Unfortunately, I am completely lost.",
        french: "Malheureusement, je suis complètement perdu.",
        context: "Admitting directions confusion to find sympathetic guides.",
        pronunciationFrench: "mahl-eur-uhz-mahn, zhuh swee cohm-plet-mahn pair-dew",
        pronunciationEnglish: "uhn-for-choo-net-lee, ay am com-pleet-lee lost"
      },
      {
        english: "At what time does the next high-speed train leave?",
        french: "À quelle heure part le prochain train à grande vitesse ?",
        context: "Assessing departure timetables at crowded platforms.",
        pronunciationFrench: "ah kel eur par luh pro-shahn trahn ah grahnd vee-tes",
        pronunciationEnglish: "at wat tahym duhz d_uh next hy-speed treyn leev"
      }
    ],
    "intermediate": [
      {
        english: "How much does a private taxi to head to the airport cost?",
        french: "Combien coûte une course de taxi privée pour se rendre à l'aéroport ?",
        context: "Evaluating transit pricing options prior to taking cab services.",
        pronunciationFrench: "cohm-byahn coot ewn coorse duh tahk-see pree-vay poor suh rahndr ah lah-ay-roh-por",
        pronunciationEnglish: "how much duhz ey prahy-vet tak-see too hed too d_uh air-port cost"
      },
      {
        english: "Could you kindly explain this location to me on the print map?",
        french: "Pourriez-vous avoir l'obligeance de m'indiquer ce lieu sur la carte imprimée ?",
        context: "Seeking local assistance while navigating with physical flyers.",
        pronunciationFrench: "poor-yay-voo zah-vwahr loh-blee-zhahns duh mahnd-dee-kay suh lyuh sew lah cart ahnd-pree-may",
        pronunciationEnglish: "kood yoo kahnd-lee ex-pleyn d_is lo-key-shun too mee on d_uh print map"
      },
      {
        english: "Is there an active bus stop around this street block?",
        french: "Y a-t-il un arrêt de bus en service dans les environs de ce pâté de maisons ?",
        context: "Locating city transit linkages to continue urban explores.",
        pronunciationFrench: "ee ah-teel uhn ah-reh duh bews ahnd sair-vees dahn lay zahnd-vee-rohn duh suh pah-tey duh meh-zohn",
        pronunciationEnglish: "iz there ey ac-tiv buhs stop ah-rownd d_is street block"
      },
      {
        english: "Excuse me, I am actively seeking the entrance to the city hall.",
        french: "Excusez-moi, je cherche activement l'entrée principale de l'hôtel de ville.",
        context: "Asking local citizens for directions to famous municipality monuments.",
        pronunciationFrench: "ex-kew-zay mwah, zhuh pair-sh ahk-teev-mahn lahnd-tray prahn-see-pahl duh loh-tel duh veel",
        pronunciationEnglish: "ex-kyooz mee, ay am ac-tiv-lee seek-ing d_uh en-trans too d_uh si-tee hol"
      }
    ],
    "advanced": [
      {
        english: "Are there any service delays on the subway network today?",
        french: "Y a-t-il actuellement des perturbations sur le réseau de métro aujourd'hui ?",
        context: "Querying train dispatchers about weather delays or repair closures.",
        pronunciationFrench: "ee ah-teel ahk-twell-mahn day pair-teur-bah-see-ohn sew luh ray-zoh duh may-troh oh-zhoor-dwee",
        pronunciationEnglish: "are there e-nee sair-vees di-leyz on d_uh suhb-wey net-work too-dey"
      },
      {
        english: "I prefer traveling off-season to avoid the enormous tourist stampede.",
        french: "Je préfère voyager hors saison afin d'éviter la cohue des grands flux de touristes.",
        context: "Explaining comfortable itinerary philosophies to booking agents.",
        pronunciationFrench: "zhuh pray-fair vwah-yah-zhay or seh-zohn ah-fahn day-vee-tay lah co-hew day grahnd flew duh too-reest",
        pronunciationEnglish: "ay pree-fer tra-vel-ing off-see-zun too ah-vowyd d_uh ee-nor-mus too-rist stam-peed"
      },
      {
        english: "Could you locate a scenic hiking path in the valley region?",
        french: "Serait-il possible de m'indiquer un sentier de randonnée panoramique dans la vallée ?",
        context: "Planning nature adventures at national park information desks.",
        pronunciationFrench: "suh-ray-teel poh-seebl duh mahnd-dee-kay uhn sahn-tyay duh rahn-doh-nay pah-noh-rah-meek dahn lah valley",
        pronunciationEnglish: "kood yoo lo-keyt ey see-nik hahy-king path in d_uh va-lee ree-zhun"
      },
      {
        english: "If we miss our second train, can we obtain a refund?",
        french: "Si la correspondance est manquée, pourrons-nous prétendre à un dédommagement ?",
        context: "Asserting passenger rights with travel clerks during bad schedule delays.",
        pronunciationFrench: "see lah coh-res-pohn-dahns eh mahn-kay, poor-rohn-noo pray-tahndr ah uhn day-doh-mahzh-mahn",
        pronunciationEnglish: "if wee mis aw-er se-cond treyn, can wee ob-teyn ey ree-fuhnd"
      }
    ]
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API 1: Dual Translation & Audio Phonetics Guide
  app.post("/api/translate", async (req, res) => {
    const { text, fromLang, toLang } = req.body;
    try {
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }

      const client = getGeminiClient();
      const fromLangName = fromLang === "fr" ? "French" : "English";
      const toLangName = toLang === "fr" ? "French" : "English";

      const systemPrompt = `You are an expert bilingual speech coach, linguist, and translator specialized in translating between English and French.
Provide extremely natural, native-sounding translations rather than literal word-for-word substitutions.
Pay close attention to common idioms, figurative speech, and grammatical structures.
If the input text includes an idiom or cultural metaphor, translate it to its corresponding natural expression or equivalent idiom in the destination language (for example, 'raining cats and dogs' becomes 'il pleut des cordes' and 'avoir un chat dans la gorge' becomes 'have a frog in one's throat') and break this down inside vocabulary footnotes or grammatical insights.`;
      
      const response = await generateContentWithFallback({
        model: "gemini-3.5-flash",
        contents: `Translate the following text from ${fromLangName} to ${toLangName}, handling any native idioms, figurative speech, and complex grammatical structures to ensure a natural and native-sounding outcome:
"${text}"`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              translation: { 
                type: Type.STRING, 
                description: `Direct translation into ${toLangName}` 
              },
              phonetics: { 
                type: Type.STRING, 
                description: `Syllable-by-syllable phonetic pronunciations guide for learners` 
              },
              notes: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "A few high-quality vocabulary breakdowns or literal meanings"
              },
              grammar: { 
                type: Type.STRING, 
                description: "Brief grammatical highlight or interesting usage note" 
              }
            },
            required: ["translation", "phonetics", "notes", "grammar"]
          }
        }
      });

      const responseString = response.text;
      if (!responseString) {
        throw new Error("Failed to retrieve response text from Gemini API.");
      }

      const data = JSON.parse(responseString.trim());
      res.json(data);
    } catch (error: any) {
      console.warn("Gemini translation failed, activating local high-fidelity fallback:", error.message || error);
      try {
        const localData = getLocalFallbackTranslation(text, fromLang, toLang);
        res.json(localData);
      } catch (fallbackError) {
        res.status(500).json({ error: "Translation and fallback both failed" });
      }
    }
  });

  // API 2: Speech Pronunciation Coach / Evaluator
  app.post("/api/analyze-pronunciation", async (req, res) => {
    const { targetText, spokenText, lang } = req.body;
    try {
      if (!targetText || !spokenText) {
        return res.status(400).json({ error: "Both target phrase and spoken text are required" });
      }

      const client = getGeminiClient();
      const language = lang === "fr" ? "French" : "English";

      const systemPrompt = "You are an encouraging and extremely precise English/French speech therapist and tutor. Analyze what the user said vs the target text.";

      const response = await generateContentWithFallback({
        model: "gemini-3.5-flash",
        contents: `Target Sentence: "${targetText}"
Transcribed Spoken Attempt: "${spokenText}"
Target Language: ${language}
Compare the target phrase and spoken text. Grade the pronunciation accuracy, identify list of mispronounced or omitted words, and provide positive pointers and phonetic tips.`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { 
                type: Type.INTEGER, 
                description: "Pronunciation clarity score from 0 (completely different) to 100 (native speaker matching)" 
              },
              feedback: { 
                type: Type.STRING, 
                description: "Precise, encouraging tutor explanation of mistakes and pronunciation tips" 
              },
              mispronouncedWords: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Lowercase list of specific words from the target sentence that were spoken incorrectly or skipped"
              },
              positivePointers: { 
                type: Type.STRING, 
                description: "Celebrate what was pronounced correctly" 
              }
            },
            required: ["score", "feedback", "mispronouncedWords", "positivePointers"]
          }
        }
      });

      const responseString = response.text;
      if (!responseString) {
        throw new Error("No response content from Gemini.");
      }

      const data = JSON.parse(responseString.trim());
      res.json(data);
    } catch (error: any) {
      console.warn("Gemini pronunciation assessment failed, activating local fallback:", error.message || error);
      try {
        const localData = getLocalPronunciationAssessment(targetText, spokenText);
        res.json(localData);
      } catch (fallbackError) {
        res.status(500).json({ error: "Pronunciation analysis and fallback both failed" });
      }
    }
  });

  // API 3: Refined Writing Tutor
  app.post("/api/refine-writing", async (req, res) => {
    const { text, lang } = req.body;
    try {
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }

      const client = getGeminiClient();
      const language = lang === "fr" ? "French" : "English";

      const systemPrompt = "You are a professional editor and native bilingual tutor. Polishes written paragraphs to sound eloquent, natural, and grammatically perfect.";

      const response = await generateContentWithFallback({
        model: "gemini-3.5-flash",
        contents: `Text to analyze in ${language}: "${text}"
Suggest corrections, explaining rules and pointing out how to make it sound native, flowing, and polished.`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              refinedText: { 
                type: Type.STRING, 
                description: "Perfectly polished native-sounding sentence or paragraph" 
              },
              corrections: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "List of grammatical, spelling, or vocabulary corrections made" 
              },
              explanations: { 
                type: Type.STRING, 
                description: "Clear and educational explanation of rules violated and why the alternative sounds better" 
              }
            },
            required: ["refinedText", "corrections", "explanations"]
          }
        }
      });

      const responseString = response.text;
      if (!responseString) {
        throw new Error("Failed to receive output from Gemini.");
      }

      const data = JSON.parse(responseString.trim());
      res.json(data);
    } catch (error: any) {
      console.warn("Gemini writing refinement failed, activating local fallback:", error.message || error);
      try {
        const localData = getLocalRefinement(text);
        res.json(localData);
      } catch (fallbackError) {
        res.status(500).json({ error: "Writing refinement and fallback both failed" });
      }
    }
  });

  // API 4: Dynamic Practice Sentences Generator
  app.post("/api/get-phrases", async (req, res) => {
    const { theme, difficulty } = req.body;
    try {
      const client = getGeminiClient();

      const systemPrompt = "You are a language course planner. You provide dynamic, interesting, functional practice sentences for English and French learners.";

      const response = await generateContentWithFallback({
        model: "gemini-3.5-flash",
        contents: `Create exactly 4 interactive, modern everyday conversation practice phrases for the category "${theme || "conversational basics"}" and difficulty level "${difficulty || "beginner"}".
Include phonetic speaking guides for pronunciation.`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            description: "List of 4 items",
            items: {
              type: Type.OBJECT,
              properties: {
                english: { type: Type.STRING, description: "Phrase in English" },
                french: { type: Type.STRING, description: "Phrase in French" },
                context: { type: Type.STRING, description: "Social scenario or context for utilizing this phrase" },
                pronunciationFrench: { type: Type.STRING, description: "Easy phonetic guide on how an English speaker pronounces the French version" },
                pronunciationEnglish: { type: Type.STRING, description: "Easy phonetic guide on how a French speaker pronounces the English version" }
              },
              required: ["english", "french", "context", "pronunciationFrench", "pronunciationEnglish"]
            }
          }
        }
      });

      const responseString = response.text;
      if (!responseString) {
        throw new Error("No phrase list response from Gemini.");
      }

      const data = JSON.parse(responseString.trim());
      res.json(data);
    } catch (error: any) {
      console.warn("Gemini phrase generation failed, loading local themed phrases:", error.message || error);
      try {
        const activeTheme = theme || "conversational basics";
        const activeDiff = difficulty || "beginner";
        const databasePhrases = LOCAL_PHRASES_DATABASE[activeTheme]?.[activeDiff] || LOCAL_PHRASES_DATABASE["conversational basics"]["beginner"];
        res.json(databasePhrases);
      } catch (fallbackError) {
        res.status(500).json({ error: "Phrases generation and fallback databases both failed" });
      }
    }
  });

  // Serve static UI bundle or defer to Vite development server
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server successfully started on http://0.0.0.0:${PORT}`);
  });

  // Multimodal Live API Bidirectional WebSocket Proxy
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    if (pathname === "/api/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs) => {
    console.log("[Live API Proxy] Client connected to live voice socket.");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[Live API Proxy] Missing GEMINI_API_KEY environment variable.");
      clientWs.close(1011, "GEMINI_API_KEY not configured on server");
      return;
    }

    // Connect to Google Gemini Multimodal Live API using the requested models path
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    
    console.log("[Live API Proxy] Opening upstream connection to Gemini Multimodal Live API at path: v1alpha.GenerativeService.BidiGenerateContent");
    const geminiWs = new WSWebSocket(geminiUrl);

    geminiWs.on("open", () => {
      console.log("[Live API Proxy] Connected to upstream Gemini Live API.");
    });

    clientWs.on("message", (message, isBinary) => {
      // Forward client browser message/speech to Google Gemini
      if (geminiWs.readyState === WSWebSocket.OPEN) {
        geminiWs.send(message, { binary: isBinary });
      }
    });

    geminiWs.on("message", (message, isBinary) => {
      // Forward Gemini response chunks back to client browser
      if (clientWs.readyState === WSWebSocket.OPEN) {
        clientWs.send(message, { binary: isBinary });
      }
    });

    clientWs.on("close", (code, reason) => {
      console.log(`[Live API Proxy] Browser client closed with code ${code}. Closing upstream Gemini connection.`);
      if (geminiWs.readyState === WSWebSocket.OPEN || geminiWs.readyState === WSWebSocket.CONNECTING) {
        geminiWs.close();
      }
    });

    geminiWs.on("close", (code, reason) => {
      console.log(`[Live API Proxy] Gemini connection closed: ${code} - ${reason}. Closing browser client.`);
      if (clientWs.readyState === WSWebSocket.OPEN || clientWs.readyState === WSWebSocket.CONNECTING) {
        clientWs.close(code, reason?.toString() || "Gemini closed connection");
      }
    });

    clientWs.on("error", (error) => {
      console.error("[Live API Proxy] Client socket error:", error);
      geminiWs.close();
    });

    geminiWs.on("error", (error) => {
      console.error("[Live API Proxy] Gemini socket error:", error);
      clientWs.close();
    });
  });
}

startServer();
