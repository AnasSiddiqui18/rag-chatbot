import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "fs";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { QdrantVectorStore } from "@langchain/qdrant";
import path from "path";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import "dotenv/config";
import { cors } from "hono/cors";
import { smoothStream, streamText } from "ai";
import { google } from "@ai-sdk/google";
import { streamSSE } from "hono/streaming";

const app = new Hono();

app.use("/*", cors());

app.get("/", (c) => {
    return c.json({
        status: "working",
    });
});

const resolve_path = path.resolve(path.join(process.cwd(), "/public/uploads"));

async function uploadFileToVectorDB(file_name: string) {
    try {
        const loader = new PDFLoader(`${resolve_path}/${file_name}`);
        const docs = await loader.load();

        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
            model: "text-embedding-004", // 768 dimension
        });

        const vectorStore = await QdrantVectorStore.fromDocuments(
            docs,
            embeddings,
            {
                url: "http://localhost:6333",
                collectionName: "rag-collection",
            },
        );

        fs.unlinkSync(`${resolve_path}/${file_name}`);
    } catch (error) {
        console.log("text extraction failed", error);
    }
}

app.post("/upload-pdf", async (c) => {
    const body = await c.req.parseBody();

    const image = body["file"];

    if (image instanceof File) {
        if (
            image?.type.includes("jpeg") ||
            image?.type.includes("png") ||
            image?.type.includes("docx")
        ) {
            return new Response("Only pdf are acceptable!", {
                status: 400,
            });
        }

        const buffer = await image.arrayBuffer();
        const suffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const file_buffer = Buffer.from(buffer);
        const file_name = `file-${suffix}.${image.type.split("/")[1]}`;
        fs.writeFileSync(`${resolve_path}/${file_name}`, file_buffer);
        await uploadFileToVectorDB(file_name);
        return c.json({
            message: "File uploaded successfully",
        });
    }
});

app.post("/ask", async (c) => {
    const { messages } = await c.req.json();

    const query = messages.content[messages.content.length - 1].text;

    console.log("ask runs", query);

    const embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        model: "text-embedding-004", // 768 dimension
    });

    const vectorStore = await QdrantVectorStore.fromExistingCollection(
        embeddings,
        {
            url: "http://localhost:6333",
            collectionName: "rag-collection",
        },
    );

    const ret = vectorStore.asRetriever({
        k: 2,
    });

    const result = await ret.invoke(query);

    const combinedUserMessage = `You are a friendly, knowledgeable AI assistant designed to answer user questions using context extracted from a PDF file. Your tone should be warm, enthusiastic, and conversational—like a helpful friend who’s great at explaining things clearly.

    The form builder platform described in the context is called **Formy**.
  
    ---
  
    📘 **Context**:
    ${JSON.stringify(result)}
  
    ---
  
    💬 **User Query**:
    ${query}
   
    🧠 **Instructions**:
    1. If the context is empty or does not contain relevant information, kindly let the user know that you couldn’t find anything specific in the uploaded file. In your own friendly words, guide them to upload a PDF using the **Upload** button next to the **Send** button.
  
    2. If the answer *is* found in the context, respond confidently and naturally. Rephrase or summarize the relevant content in your own words. Feel free to start with friendly phrases like “Absolutely!” or “Great question!” to make your reply feel personal and engaging. Mention the platform name **Formy** when it fits organically.
  
    3. If the context doesn't directly answer the question, but you can make a helpful guess or use general knowledge, do so — but clearly mention that the context does not contain specific information about the query.
  
    4. Always aim to keep your answers concise, helpful, and approachable.
  
    Let your personality shine while staying informative and supportive! 🎉
    `;

    const streamResponse = streamText({
        prompt: combinedUserMessage,
        model: google("gemini-2.0-flash"),
        experimental_transform: smoothStream({
            delayInMs: 30,
            chunking: "word",
        }),
    });

    return streamSSE(c, async (stream) => {
        for await (const text of streamResponse.textStream) {
            await stream.writeSSE({
                data: JSON.stringify({ content: text }),
            });
        }
    });
});

serve(
    {
        fetch: app.fetch,
        port: 4000,
    },
    ({ port }) => {
        console.log(`App is running at ${port}`);
    },
);
