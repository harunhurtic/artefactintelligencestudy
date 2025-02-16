import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import favicon from "serve-favicon";
import path from "path";
import { fileURLToPath } from "url"; // Needed for ES Modules

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const OPENAI_HEADERS = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"  // ✅ Required for Assistants API v2
};

// Get correct directory paths for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the frontend files
app.use(express.static(path.join(__dirname, "public")));  // Serves static files from "public" folder

app.use(favicon(path.join(__dirname, "public", "favicon.ico")));

// Route to serve the main HTML file
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "Index.html"));
});

// API route for fetching adapted descriptions with failure detection
app.post("/fetch-description", async (req, res) => {
    const { artefact, originalDescription, profile, participantId } = req.body;

    if (!artefact || !originalDescription || !profile || !participantId) {
        console.error("❌ Missing required fields: artefact, description, profile, or participantId");
        return res.status(400).json({ error: "Missing artefact, description, profile, or participantId" });
    }

    let prompt = `Adapt the ${artefact} description for a visitor with the ${profile} profile.\n\nParticipant ID: ${participantId}\nArtefact: ${artefact}.\nDescription: ${originalDescription}.`;

    try {
        console.log("🟢 Creating a new thread...");

        const threadResponse = await fetch("https://api.openai.com/v1/threads", {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ metadata: { participantId } }),  // ✅ Store Participant ID in OpenAI thread metadata
            timeout: 60000,
        });

        const threadData = await threadResponse.json();
        if (!threadData.id) throw new Error("Failed to create thread");

        const threadId = threadData.id;
        console.log(`✅ Created Thread ID: ${threadId} (Participant: ${participantId})`);

        console.log(`📝 Sending prompt to Assistant:\n${prompt}`);
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();
        if (!messageData.id) throw new Error("Failed to add message");

        console.log("▶️ Running Assistant...");
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();
        if (!runData.id) throw new Error("Failed to run assistant");

        const runId = runData.id;
        console.log(`✅ Assistant Run ID: ${runId} (Participant: ${participantId})`);

        let status = "in_progress";
        let responseContent = "";

        while (status === "in_progress" || status === "queued") {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
                headers: OPENAI_HEADERS,
            });

            const checkRunData = await checkRunResponse.json();
            status = checkRunData.status;
            console.log("⏳ Polling Status:", status);

            if (status === "failed") {
                console.error("❌ Assistant Run Failed:", checkRunData);
                break;
            }

            if (status === "completed") {
                console.log("📩 Fetching Assistant's Response...");
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });

                const messagesData = await messagesResponse.json();
                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                if (assistantMessage && assistantMessage.content && assistantMessage.content[0].text) {
                    responseContent = assistantMessage.content[0].text.value;
                    console.log(`🟢 Assistant response received for Participant ${participantId}:`, responseContent);
                }
                break;
            }
        }

        if (!responseContent) {
            responseContent = `The adaptation failed. However, here's the original artefact description:\n\n${originalDescription}`;
        }

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error fetching from Assistant:", error);
        res.status(500).json({ response: `The adaptation failed. However, here's the original artefact description:\n\n${originalDescription}` });
    }
});


// API route for fetching TTS audio
app.post("/fetch-tts", async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: "Missing text input for TTS" });
    }

    try {
        const audioBuffer = await fetchTTSWithRetry(text);

        res.set({
            "Content-Type": "audio/mpeg",
            "Content-Length": audioBuffer.length,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        });

        res.send(audioBuffer);
    } catch (error) {
        console.error("❌ Error fetching TTS:", error);
        res.status(500).json({ error: "Failed to generate TTS audio" });
    }
});


// ✅ Function to fetch TTS with automatic retries
async function fetchTTSWithRetry(text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`🔊 Sending TTS Request (Attempt ${i + 1})...`);

            const response = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({
                    model: "tts-1",
                    input: text,
                    voice: "nova",
                }),
                timeout: 60000,  // ✅ Increase timeout to 60s
            });

            if (!response.ok) throw new Error(`Failed to generate audio: ${response.statusText}`);

            const audioBuffer = await response.arrayBuffer();
            return Buffer.from(audioBuffer);
        } catch (error) {
            console.error(`❌ TTS attempt ${i + 1} failed:`, error);
            if (i === retries - 1) throw error; // If last retry, throw the error
            await new Promise(res => setTimeout(res, 2000)); // Wait before retrying
        }
    }
}


console.log("🔑 OpenAI API Key:", process.env.OPENAI_API_KEY ? "Loaded" : "MISSING");
console.log("🤖 Assistant ID:", process.env.ASSISTANT_ID ? "Loaded" : "MISSING");


// ✅ Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

