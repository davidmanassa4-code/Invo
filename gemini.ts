import { GoogleGenAI } from "@google/genai";

const getApiKey = () => {
  // 1. Try Vite-specific environment variable (standard for Vercel/Vite)
  if (import.meta.env.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  
  // 2. Try the platform-injected process.env variable safely
  try {
    // In many build environments, process.env.GEMINI_API_KEY is replaced at build time
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      return key;
    }
  } catch (e) {
    // process might not be defined in some browser environments
  }

  return "";
};

const ai = new GoogleGenAI({ apiKey: getApiKey() });

export async function financialSearch(query: string, institution?: string) {
  const model = "gemini-3-flash-preview";
  const systemInstruction = `You are a professional financial researcher. 
  Provide precise data points with sources. 
  Format every data point as: [Data Value] | [Source Name] | [Direct URL Hyperlink].
  If a specific institution is requested, focus strictly on their data.
  Trusted sources: IMF, World Bank, Fitch Ratings, Damodaran (NYU), Central Banks, Moody’s, S&P Global.`;

  const fullQuery = institution ? `Search within ${institution}: ${query}` : query;

  const response = await ai.models.generateContent({
    model,
    contents: fullQuery,
    config: {
      systemInstruction,
      tools: [{ googleSearch: {} }],
    },
  });

  return {
    text: response.text,
    sources: response.candidates?.[0]?.groundingMetadata?.groundingChunks || [],
  };
}

export async function generateAssumptions(country: string, industry: string) {
  const model = "gemini-3-flash-preview";
  const prompt = `Find current financial assumptions for ${country} in the ${industry} industry. 
  Include: GDP Growth, Inflation Target, Risk-Free Rate, and Industry Equity Risk Premium.
  Format as a JSON array of objects with keys: label, value, source, url.`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Failed to parse assumptions", e);
    return [];
  }
}

export async function suggestSensitivity(scenario: string) {
  const model = "gemini-3-flash-preview";
  const prompt = `Based on the scenario: "${scenario}", suggest the most critical variables for a professional 2D sensitivity analysis.
  Provide: 
  1. Target Variable (e.g., NPV, IRR, Enterprise Value)
  2. Target Unit (e.g., M, %, $)
  3. Base Target Value (numeric, the central value of the matrix)
  4. Row Variable (e.g., Sales Growth, COGS %)
  5. Column Variable (e.g., WACC, Terminal Growth)
  6. Base Value for Row (numeric)
  7. Base Value for Column (numeric)
  8. Increment for Row (numeric)
  9. Increment for Column (numeric)
  
  Format as a JSON object with keys: targetVariable, targetUnit, baseTargetValue, rowVariable, colVariable, baseValueRow, baseValueCol, incrementRow, incrementCol.`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse sensitivity suggestion", e);
    return null;
  }
}
