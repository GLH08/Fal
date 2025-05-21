// --- 配置 ---
const FAL_IMAGEN4_SUBMIT_URL = 'https://queue.fal.run/fal-ai/imagen4/preview';
const FAL_IMAGEN4_STATUS_BASE_URL = 'https://queue.fal.run/fal-ai/imagen4';
const MODEL_ID = "imagen4-preview";
const EXPECTED_AUTH_HEADER_PREFIX = "Bearer ";

export default {
  async fetch(request, env, ctx) {
    // 1. Worker Access Key Authentication
    const workerAccessKey = env.WORKER_ACCESS_KEY;
    if (!workerAccessKey) {
      console.error("WORKER_ACCESS_KEY is not configured in environment variables.");
      return new Response(JSON.stringify({ error: { message: "Worker access key not configured.", type: "configuration_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith(EXPECTED_AUTH_HEADER_PREFIX)) {
      return new Response(JSON.stringify({ error: { message: "Missing or invalid Authorization header. Expected 'Bearer YOUR_ACCESS_KEY'.", type: "authentication_error" } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const providedToken = authHeader.substring(EXPECTED_AUTH_HEADER_PREFIX.length);
    if (providedToken !== workerAccessKey) {
      return new Response(JSON.stringify({ error: { message: "Invalid access token.", type: "authentication_error" } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // --- End of Worker Access Key Authentication ---

    const url = new URL(request.url);
    const path = url.pathname;
    const falApiKey = env.FAL_API_KEY;

    if (!falApiKey) {
      return new Response(JSON.stringify({ error: { message: "FAL_API_KEY is not configured.", type: "configuration_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/v1/images/generations' && request.method === 'POST') {
      return handleImageGenerations(request, falApiKey, ctx);
    } else if (path === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletionsForImage(request, falApiKey, ctx);
    } else if (path === '/v1/models' && request.method === 'GET') {
      return listModels();
    } else {
      return new Response(JSON.stringify({ error: { message: "Not Found", type: "not_found_error" } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  }
};

async function handleImageGenerations(request, falApiKey, ctx) {
  let openaiRequest;
  try {
    openaiRequest = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { prompt, n = 1, size = "1024x1024", response_format = "url" } = openaiRequest;

  if (!prompt) {
    return new Response(JSON.stringify({ error: { message: "Parameter 'prompt' is required.", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (response_format !== "url" && response_format !== "b64_json") {
    return new Response(JSON.stringify({ error: { message: "Parameter 'response_format' must be 'url' or 'b64_json'.", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const falRequestBody = {
    prompt: prompt,
    num_images: Math.max(1, Math.min(4, Number(n))),
    aspect_ratio: mapOpenAISizeToFalAspectRatio(size),
  };

  try {
    const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx);
    const responseData = await Promise.all(falResult.images.map(async (image) => {
      if (response_format === "b64_json") {
        const imageFetchResponse = await fetch(image.url);
        if (!imageFetchResponse.ok) throw new Error(`Failed to download image from Fal.ai: ${image.url}`);
        const imageBuffer = await imageFetchResponse.arrayBuffer();
        return { b64_json: arrayBufferToBase64(imageBuffer) };
      } else {
        return { url: image.url };
      }
    }));
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: responseData }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error("Error in handleImageGenerations:", error.message, error.stack);
    return new Response(JSON.stringify({ error: { message: error.message || "Failed to generate image.", type: "api_error" } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleChatCompletionsForImage(request, falApiKey, ctx) {
  let openaiRequest;
  try {
    openaiRequest = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { messages, stream = false } = openaiRequest;
  let userPrompt = "";
  let requestedSizeFromPrompt = null;

  if (messages && Array.isArray(messages) && messages.length > 0) {
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (lastUserMessage && typeof lastUserMessage.content === 'string') {
      let tempUserPrompt = lastUserMessage.content;

      // Step 1: Try to extract size with keywords
      const keywordSizeRegex = /\b(size|aspect_ratio|比例)\s*[:=\s：]?\s*(\d+[:\/xX]\d+|\d+:\d+|\d+\/\d+)\b/gi;
      let match;
      let lastKeywordMatch = null;
      while ((match = keywordSizeRegex.exec(tempUserPrompt)) !== null) {
        lastKeywordMatch = { value: match[2], fullMatch: match[0], index: match.index };
      }

      if (lastKeywordMatch) {
        requestedSizeFromPrompt = lastKeywordMatch.value;
        tempUserPrompt = tempUserPrompt.substring(0, lastKeywordMatch.index) +
                         tempUserPrompt.substring(lastKeywordMatch.index + lastKeywordMatch.fullMatch.length);
        tempUserPrompt = tempUserPrompt.replace(/\s\s+/g, ' ').trim();
        console.log(`Extracted size '${requestedSizeFromPrompt}' via keyword. Cleaned prompt: '${tempUserPrompt}'`);
      } else {
        // Step 2: If no keyword match, try pattern-only (e.g., "9:16" standalone)
        const patternOnlySizeRegex = /\b(\d+[:\/xX]\d+)\b/gi;
        let potentialPatternMatches = [];
        while ((match = patternOnlySizeRegex.exec(tempUserPrompt)) !== null) {
          const parts = match[1].split(/[:\/xX]/);
          if (parts.length === 2) {
            const num1 = parseInt(parts[0],10);
            const num2 = parseInt(parts[1],10);
            // Basic filter: avoid excessively large numbers or zero/invalid numbers
            if (num1 > 0 && num1 < 5000 && num2 > 0 && num2 < 5000) {
              potentialPatternMatches.push({ value: match[1], fullMatch: match[0], index: match.index });
            }
          }
        }

        if (potentialPatternMatches.length > 0) {
          const chosenPatternMatch = potentialPatternMatches[potentialPatternMatches.length - 1]; // Take the last one
          requestedSizeFromPrompt = chosenPatternMatch.value;
          tempUserPrompt = tempUserPrompt.substring(0, chosenPatternMatch.index) +
                           tempUserPrompt.substring(chosenPatternMatch.index + chosenPatternMatch.fullMatch.length);
          tempUserPrompt = tempUserPrompt.replace(/\s\s+/g, ' ').trim();
          console.log(`Extracted size '${requestedSizeFromPrompt}' via pattern-only. Cleaned prompt: '${tempUserPrompt}'`);
        }
      }
      userPrompt = tempUserPrompt;
    }
  }

  if (!userPrompt && !requestedSizeFromPrompt) {
    const defaultMessage = `Please provide a description for the image. You can also specify a ratio, e.g., 'a cat 比例:16:9' or 'a dog 9:16'.`;
    if (stream) return createStreamingChatResponseHelper(generateRandomId(), MODEL_ID, [{ type: "text", content: defaultMessage }], "stop");
    return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), MODEL_ID, defaultMessage, "stop")), { headers: { 'Content-Type': 'application/json' } });
  } else if (!userPrompt && requestedSizeFromPrompt) {
    userPrompt = "image"; // Default prompt if only size is given
    console.log(`Only size '${requestedSizeFromPrompt}' found in prompt, using generic prompt: '${userPrompt}'`);
  }

  const finalSize = requestedSizeFromPrompt || openaiRequest.size || "1024x1024";
  const falRequestBody = {
    prompt: userPrompt,
    num_images: 1,
    aspect_ratio: mapOpenAISizeToFalAspectRatio(finalSize),
  };

  if (stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const chatRequestId = `chatcmpl-${generateRandomId()}`;

    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, MODEL_ID, { role: "assistant" }, null))}\n\n`));
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, MODEL_ID, { content: `🎨 Generating image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio}...` }, null))}\n\n`));

    ctx.waitUntil((async () => {
      try {
        const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx);
        const imageUrl = falResult.images && falResult.images[0] ? falResult.images[0].url : null;
        const imageMarkdown = imageUrl ? `\n\nHere is the image:\n\n![Generated Image](${imageUrl})` : "\n\nSorry, I couldn't generate the image this time.";
        writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, MODEL_ID, { content: imageMarkdown }, null))}\n\n`));
        writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, MODEL_ID, {}, "stop"))}\n\n`));
      } catch (error) {
        console.error("Streaming error:", error.message, error.stack);
        try { writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(chatRequestId, MODEL_ID, { content: `\n\nAn error occurred: ${error.message}` }, "stop"))}\n\n`)); } catch (e) {}
      } finally {
        writer.write(encoder.encode('data: [DONE]\n\n'));
        try { await writer.close(); } catch (e) {}
      }
    })());
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
  } else {
    try {
      const falResult = await executeFalImageRequest(falRequestBody, falApiKey, ctx);
      const imageUrl = falResult.images && falResult.images[0] ? falResult.images[0].url : null;
      const responseContent = imageUrl ? `Generated image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio}\n\n![Generated Image](${imageUrl})` : `Sorry, I couldn't generate image with prompt: "${userPrompt}" and aspect ratio: ${falRequestBody.aspect_ratio}.`;
      return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), MODEL_ID, responseContent, "stop")), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      console.error("Non-streaming error:", error.message, error.stack);
      return new Response(JSON.stringify(createNonStreamingChatResponseHelper(generateRandomId(), MODEL_ID, `An error occurred for prompt "${userPrompt}" with aspect ratio ${falRequestBody.aspect_ratio}: ${error.message}`, "stop")), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
}

async function executeFalImageRequest(falRequestBody, falApiKey, ctx) {
  const falSubmitResponse = await fetch(FAL_IMAGEN4_SUBMIT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falApiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(falRequestBody),
  });
  if (!falSubmitResponse.ok) {
    const errorText = await falSubmitResponse.text();
    throw new Error(`Fal.ai API request failed with status ${falSubmitResponse.status}: ${errorText}`);
  }
  const submitResult = await falSubmitResponse.json();
  const requestId = submitResult.request_id;
  if (!requestId) throw new Error('Fal.ai submission did not yield a request_id.');
  console.log(`Fal.ai job submitted. Request ID: ${requestId}`);

  const maxAttempts = 45, pollIntervalMs = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const statusUrl = `${FAL_IMAGEN4_STATUS_BASE_URL}/requests/${requestId}/status`;
    let statusData;
    try {
      const statusResponse = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falApiKey}`, 'Accept': 'application/json' } });
      if (!statusResponse.ok) {
        console.warn(`Fal.ai status check for ${requestId} failed (attempt ${attempt + 1}): ${statusResponse.status} ${await statusResponse.text()}. Retrying...`);
        if (attempt > maxAttempts - 5 && statusResponse.status >= 500) throw new Error(`Fal.ai status check failed repeatedly for ${requestId}. Last status: ${statusResponse.status}`);
        continue;
      }
      statusData = await statusResponse.json();
    } catch (e) {
      console.warn(`Network error during Fal.ai status check for ${requestId} (attempt ${attempt + 1}): ${e.message}. Retrying...`);
      continue;
    }
    console.log(`Polling attempt ${attempt + 1}/${maxAttempts} for ${requestId}. Status: ${statusData.status}`);
    if (statusData.status === 'COMPLETED') {
      const resultUrl = `${FAL_IMAGEN4_STATUS_BASE_URL}/requests/${requestId}`;
      const resultResponse = await fetch(resultUrl, { headers: { 'Authorization': `Key ${falApiKey}`, 'Accept': 'application/json' } });
      if (resultResponse.ok) {
        const resultData = await resultResponse.json();
        if (!resultData.images || resultData.images.length === 0) throw new Error(`Fal.ai job ${requestId} completed but returned no images.`);
        return resultData;
      } else {
        throw new Error(`Failed to fetch result for completed Fal.ai job ${requestId} (status ${resultResponse.status}): ${await resultResponse.text()}`);
      }
    } else if (statusData.status === 'FAILED' || statusData.status === 'CANCELLED') {
      throw new Error(`Fal.ai request ${requestId} ${statusData.status}. Logs: ${statusData.logs ? JSON.stringify(statusData.logs) : 'No logs.'}`);
    }
  }
  throw new Error(`Image generation timed out for request ${requestId}.`);
}

function mapOpenAISizeToFalAspectRatio(size) {
  if (!size) return "1:1";
  const s = String(size).toLowerCase().replace('/', ':');
  switch (s) {
    case "256x256": case "512x512": case "1024x1024": case "1:1": return "1:1";
    case "1792x1024": case "16:9": return "16:9";
    case "1024x1792": case "9:16": return "9:16";
    case "4:3": return "4:3";
    case "3:4": return "3:4";
    default:
      const parts = s.split(/[:x]/);
      if (parts.length === 2) {
        const w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
        if (w && h) { // Ensure w and h are valid numbers
          const ratio = w / h;
          if (Math.abs(ratio - 1) < 0.05) return "1:1";
          if (Math.abs(ratio - (16/9)) < 0.1) return "16:9";
          if (Math.abs(ratio - (9/16)) < 0.1) return "9:16";
          if (Math.abs(ratio - (4/3)) < 0.1) return "4:3";
          if (Math.abs(ratio - (3/4)) < 0.1) return "3:4";
        }
      }
      console.warn(`Unmapped or invalid size '${size}', defaulting to 1:1.`);
      return "1:1";
  }
}

async function listModels() {
  const timestamp = Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", created: timestamp, owned_by: "fal-ai", permission: [], root: MODEL_ID, parent: null }] }), { headers: { 'Content-Type': 'application/json' } });
}

function arrayBufferToBase64(buffer) {
  let binary = ''; const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function generateRandomId(length = 24) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createChatChunk(requestId, model, delta, finishReason) {
  return { id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: delta, finish_reason: finishReason }] };
}

function createNonStreamingChatResponseHelper(chatRequestId, model, content, finishReason) {
  const id = chatRequestId ? `chatcmpl-${chatRequestId}` : `chatcmpl-${generateRandomId()}`;
  return { id: id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: finishReason }], usage: { prompt_tokens: Math.ceil((content.length||0)/4), completion_tokens: Math.ceil((content.length||0)/2), total_tokens: Math.ceil((content.length||0)*0.75) } };
}

function createStreamingChatResponseHelper(chatRequestId, model, contentChunks, finalFinishReason) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(); const encoder = new TextEncoder();
  const id = chatRequestId ? `chatcmpl-${chatRequestId}` : `chatcmpl-${generateRandomId()}`;
  (async () => {
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, model, { role: "assistant" }, null))}\n\n`));
    for (const chunk of contentChunks) if (chunk.type === "text") writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, model, { content: chunk.content }, null))}\n\n`));
    writer.write(encoder.encode(`data: ${JSON.stringify(createChatChunk(id, model, {}, finalFinishReason))}\n\n`));
    writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  })();
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
}


