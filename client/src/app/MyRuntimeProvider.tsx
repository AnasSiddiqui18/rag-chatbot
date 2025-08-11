"use client";

import { useState, type ReactNode } from "react";
import {
    AppendMessage,
    AssistantRuntimeProvider,
    ThreadMessageLike,
    useExternalStoreRuntime,
} from "@assistant-ui/react";
import { generateId } from "ai";

export function MyRuntimeProvider({
    children,
}: Readonly<{
    children: ReactNode;
}>) {
    const [messages, setMessages] = useState<ThreadMessageLike[]>([]);

    const convertMessage = (message: ThreadMessageLike) => {
        return message;
    };

    const onNew = async (message: AppendMessage) => {
        if (message.content.length !== 1 || message.content[0]?.type !== "text")
            throw new Error("Only text content is supported");

        const res = await fetch("http://localhost:4000/ask", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                messages: message,
            }),
        });

        const userMessage: ThreadMessageLike = {
            role: "user",
            content: [{ type: "text", text: message.content[0].text }],
        };

        setMessages((prev) => [...prev, userMessage]);

        const assistantId = generateId();

        const assistantMessage: ThreadMessageLike = {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            id: assistantId,
        };

        setMessages((prev) => [...prev, assistantMessage]);

        let done = false;

        const reader = res.body!.getReader()!;
        const decoder = new TextDecoder();

        while (!done) {
            const { done: doneReading, value } = await reader.read();
            if (doneReading) done = true;

            const json_chunk = decoder.decode(value, { stream: true }).slice(5);

            const llm_response = json_chunk.length
                ? JSON.parse(json_chunk).content
                : "";

            setMessages((prev) =>
                prev.map((m) =>
                    m.id === assistantId &&
                    Array.isArray(m.content) &&
                    "text" in m.content[0]
                        ? {
                              ...m,
                              content: [
                                  {
                                      type: "text",
                                      text: m.content[0].text + llm_response,
                                  },
                              ],
                          }
                        : m,
                ),
            );
        }
    };

    const runtime = useExternalStoreRuntime({
        messages,
        setMessages,
        onNew,
        convertMessage,
    });

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            {children}
        </AssistantRuntimeProvider>
    );
}
