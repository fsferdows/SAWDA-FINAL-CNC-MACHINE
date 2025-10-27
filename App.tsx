import React, { useState } from 'react';
import type { DesignOptions, TranscriptEntry } from './types';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Preview } from './components/Preview';
import { LiveAssistant } from './components/LiveAssistant';
import { CommandBar } from './components/CommandBar';
import { LoginScreen } from './components/LoginScreen';
import { GoogleGenAI, Modality } from '@google/genai';

const blobUrlToBase64 = async (blobUrl: string): Promise<{ base64Data: string; mimeType: string }> => {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        return reject(new Error("Failed to read file as data URL"));
      }
      const dataUrl = reader.result;
      const base64Data = dataUrl.split(',')[1];
      resolve({ base64Data, mimeType: blob.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


const App: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [designOptions, setDesignOptions] = useState<DesignOptions>({
    designType: '2D Flat',
    material: 'Wood',
    width: 800,
    height: 600,
    depth: 20,
    outputFormat: 'JD',
    prompt: '',
    outlineThickness: 5,
    depthLayers: 5,
  });
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [generatedPreview, setGeneratedPreview] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleGenerate = async () => {
    const sourceImageUrl = generatedPreview || imagePreview;
    if (!sourceImageUrl) {
      alert('Please upload an image first.');
      return;
    }
    setIsLoading(true);
    
    // Keep the old preview while generating a new one for a smoother experience
    if (!generatedPreview) {
        setGeneratedPreview(null);
    }

    try {
      if (!process.env.API_KEY) {
        throw new Error("API_KEY environment variable not set.");
      }
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const { base64Data, mimeType } = await blobUrlToBase64(sourceImageUrl);

      const imagePart = {
        inlineData: {
          data: base64Data,
          mimeType: mimeType,
        },
      };
      
      let promptDetails = '';

      if (designOptions.designType === '2D Flat') {
        promptDetails = `Generate an ultra-high quality, high-contrast, monochrome black and white bitmap image suitable for a 2D wood engraving. The output must be exceptionally clean and professional, ready for a CNC toolpath.
- BLACK areas represent the parts to be ENGRAVED.
- WHITE areas represent the UNTOUCHED wood surface.
- The design must consist of clean, solid, crisp lines and shapes with vector-like precision.
- Absolutely NO gray tones, dithering, anti-aliasing, or compression artifacts. The edges must be perfectly sharp.
- The outline thickness should be ${designOptions.outlineThickness} on a relative scale of 1 to 10.
- The final image should be of the highest possible resolution and clarity.`;
      } else { // 3D Relief or Mixed
        promptDetails = `Generate a studio-quality, ultra-high resolution grayscale depth map suitable for a 3D relief wood carving. The output must be flawless and artifact-free, ready for CNC machining.
- WHITE (#FFFFFF) represents the highest point (the uncarved surface of the wood).
- BLACK (#000000) represents the deepest engraved point.
- Use smooth, flawless gradients and a full, well-distributed range of grayscale values to represent the varying depths. This is critical as the design will be sliced into ${designOptions.depthLayers} distinct depth layers for machining.
- The design should have well-defined, crisp edges, with the sharpness corresponding to an outline thickness of ${designOptions.outlineThickness} on a scale of 1 to 10.
- Avoid any posterization, banding, or compression artifacts. The gradients must be perfectly smooth.
- The final image should be of the highest possible quality and detail.`;
      }

      const accuracyInstruction = `Your primary task is to create a production-quality CNC design for furniture based on the reference image. The final output must be of the highest possible quality and clarity.
**Correction First:** Analyze the source image for any perspective distortion or angle. Correct it to produce a clean, straight-on, orthographic view of the furniture. This step is crucial for accuracy.
**High Fidelity & Ultra Quality:** The final design must be a highly accurate and faithful representation of the furniture in the reference image. Preserve the core shapes, proportions, and key features. The final image output must be extremely clear, crisp, and artifact-free, suitable for direct use in professional manufacturing.`;

      let fullPrompt = accuracyInstruction;

      if (generatedPreview && designOptions.prompt) {
        fullPrompt += `\nThen, modify the design based on these new instructions: "${designOptions.prompt}".`;
      } else if (designOptions.prompt) {
        fullPrompt += `\nApply the following style or modifications: "${designOptions.prompt}".`;
      } else if (!generatedPreview) {
        fullPrompt += `\nGenerate a new CNC-ready design for this furniture piece.`;
      }

      fullPrompt += `\n\n--- DESIGN SPECIFICATIONS ---\n`;
      fullPrompt += `The design is for "${designOptions.material}" furniture, with physical dimensions of ${designOptions.width}mm x ${designOptions.height}mm x ${designOptions.depth}mm.`;
      fullPrompt += `\n\n--- OUTPUT REQUIREMENTS ---\n${promptDetails}`;


      const textPart = {
        text: fullPrompt,
      };
      
      const systemInstruction = `You are an expert CNC furniture designer. Your primary goal is to convert user photos of furniture into production-ready, ultra-high-quality, and highly accurate CNC engraving plans. A critical part of your task is to analyze the source image for perspective distortion or awkward angles and correct it to produce a clean, straight-on, orthographic view before generating the final design. The output must be a faithful representation of the reference furniture, suitable for professional manufacturing with zero tolerance for artifacts or low quality.`;

      const generateParams = {
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [imagePart, textPart],
        },
        config: {
            systemInstruction: systemInstruction,
            responseModalities: [Modality.IMAGE],
        },
      };

      let response;
      let attempt = 1;
      while (true) {
        try {
          response = await ai.models.generateContent(generateParams);
          break; // Success
        } catch (error: any) {
          const isRateLimitError = error?.toString().includes('429') || error?.error?.status === 'RESOURCE_EXHAUSTED';
          if (isRateLimitError) {
            const delay = Math.min(30000, Math.pow(2, attempt - 1) * 1000 + Math.random() * 1000); // Cap delay at 30s
            console.warn(`Rate limit exceeded. Retrying in ${Math.round(delay)}ms... (Attempt ${attempt})`);
            await sleep(delay);
            attempt++;
          } else {
            throw error; // A non-retriable error occurred
          }
        }
      }
      
      let foundImage = false;
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const base64ImageBytes: string = part.inlineData.data;
          const imageUrl = `data:${part.inlineData.mimeType};base64,${base64ImageBytes}`;
          setGeneratedPreview(imageUrl);
          foundImage = true;
          break;
        }
      }
      if (!foundImage) {
        throw new Error("The AI did not return an image. Please try a different prompt.");
      }

    } catch (error: any) {
      console.error("Error generating design:", error);
      let errorMessage = "An unknown error occurred. Please check the console for details.";
      if (error?.error?.message) {
        errorMessage = error.error.message;
      } else if (error.message) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      alert(`Failed to generate design: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleLogin = () => setIsAuthenticated(true);
  const handleLogout = () => setIsAuthenticated(false);

  if (!isAuthenticated) {
    return <LoginScreen onLoginSuccess={handleLogin} />;
  }

  return (
    <div className="flex flex-col h-screen font-sans">
      <Header onLogout={handleLogout} />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-auto">
          <Sidebar
            options={designOptions}
            setOptions={setDesignOptions}
            onImageUpload={(url) => {
              setImagePreview(url);
              setGeneratedPreview(null);
            }}
          />
          <Preview
            imagePreview={imagePreview}
            generatedPreview={generatedPreview}
            isLoading={isLoading}
            options={designOptions}
          />
        </div>
        <CommandBar
          prompt={designOptions.prompt}
          setPrompt={(newPrompt) => setDesignOptions(prev => ({ ...prev, prompt: newPrompt }))}
          onGenerate={handleGenerate}
          isLoading={isLoading}
          hasGeneratedImage={!!generatedPreview}
        />
      </main>
      <LiveAssistant />
    </div>
  );
};

export default App;