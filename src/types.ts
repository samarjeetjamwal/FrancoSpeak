export interface TranslationResponse {
  translation: string;
  phonetics: string;
  notes: string[];
  grammar: string;
}

export interface PronunciationResponse {
  score: number;
  feedback: string;
  mispronouncedWords: string[];
  positivePointers: string;
}

export interface RefineWritingResponse {
  refinedText: string;
  corrections: string[];
  explanations: string;
}

export interface PracticePhrase {
  english: string;
  french: string;
  context: string;
  pronunciationFrench: string;
  pronunciationEnglish: string;
}

export type LanguageCode = "en" | "fr";

export interface SpeechConfig {
  voiceName: string;
  rate: number;
}
