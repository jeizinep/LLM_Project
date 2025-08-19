import { serve } from "bun";
import dotenv from "dotenv";

dotenv.config();

// Configuration from environment for security and flexibility
const LANGFLOW_BASE = process.env.LANGFLOW_BASE ?? "http://localhost:7860";
const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY ?? "";
const PORT = Number(process.env.PROXY_PORT ?? "3001");

// Restrict CORS to a trusted origin (set ALLOWED_ORIGIN env or default to localhost dev)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";

function corsHeaders(origin: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
  if (origin && origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }
  return headers;
}

async function main() {
  serve({
    port: PORT,
    // Increase the idle timeout for streaming responses (within Bun's limit of 255 seconds)
    idleTimeout: 255,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const origin = req.headers.get("origin");

        console.log(`${req.method} ${url.pathname} from origin: ${origin}`);

        if (req.method === "OPTIONS") {
          return new Response(null, { 
            status: 204, 
            headers: corsHeaders(origin) 
          });
        }

        // Only allow two safe endpoints: /api/flows and /api/chat. Everything else 404.
        if (url.pathname === "/api/flows" && req.method === "GET") {
          try {
            // Use the correct Langflow API endpoint: GET /api/v1/flows/
            const headers: Record<string, string> = {
              "Accept": "application/json",
              "Accept-Encoding": "gzip, deflate"
            };
            if (LANGFLOW_API_KEY) {
              // Try different auth header formats that Langflow might expect
              headers["Authorization"] = `Bearer ${LANGFLOW_API_KEY}`;
              headers["x-api-key"] = LANGFLOW_API_KEY;
            }
            
            console.log(`Fetching flows from: ${LANGFLOW_BASE}/api/v1/flows/`);
            console.log(`API Key present: ${LANGFLOW_API_KEY ? 'Yes' : 'No'}`);
            console.log(`API Key length: ${LANGFLOW_API_KEY ? LANGFLOW_API_KEY.length : 0}`);
            
            // First try without authentication to see if auth is disabled
            console.log("Trying without authentication first...");
            let res = await fetch(LANGFLOW_BASE + "/api/v1/flows/", { 
              headers: {
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate"
              }
            });
            
            if (!res.ok && LANGFLOW_API_KEY) {
              console.log("Auth-less request failed, trying with API key...");
              res = await fetch(LANGFLOW_BASE + "/api/v1/flows/", { headers });
            }
            
            console.log(`Response status: ${res.status} ${res.statusText}`);
            
            if (!res.ok) {
              console.error(`Langflow API error: ${res.status} ${res.statusText}`);
              return new Response(JSON.stringify({ 
                error: "Failed to fetch flows", 
                status: res.status,
                statusText: res.statusText,
                url: LANGFLOW_BASE + "/api/v1/flows/"
              }), { 
                status: res.status, 
                headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
              });
            }
            
            const json = await res.json().catch((err) => {
              console.error("Failed to parse JSON response:", err);
              return null;
            });
            
            if (json) {
              console.log(`Successfully fetched ${Array.isArray(json) ? json.length : 'unknown'} flows`);
              return new Response(JSON.stringify(json), { 
                status: 200, 
                headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
              });
            }
            
            return new Response(JSON.stringify({ error: "Invalid response from Langflow" }), { 
              status: 502, 
              headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
            });
          } catch (error) {
            console.error("Error fetching flows:", error);
            return new Response(JSON.stringify({ 
              error: "Network error when fetching flows",
              details: String(error),
              langflowUrl: LANGFLOW_BASE + "/api/v1/flows/"
            }), { 
              status: 500, 
              headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
            });
          }
        }

        if (url.pathname === "/api/chat" && (req.method === "POST" || req.method === "GET")) {
          // Extract parameters from either query params (GET) or body (POST)
          let message = "";
          let flow_id = undefined;
          let streaming = false;
          
          if (req.method === "GET") {
            // Get parameters from query string
            message = url.searchParams.get("message") || "";
            flow_id = url.searchParams.get("flow_id") || undefined;
            streaming = url.searchParams.get("stream") === "true";
            console.log("GET request parameters:", { message, flow_id, streaming });
          } else {
            // Get parameters from POST body
            const body = await req.json().catch(() => ({}));
            message = typeof body.message === "string" ? body.message : "";
            flow_id = typeof body.flow_id === "string" ? body.flow_id : undefined;
            streaming = typeof body.stream === "boolean" ? body.stream : false;
            console.log("POST request parameters:", { message, flow_id, streaming });
          }
          
          if (!message) {
            return new Response(JSON.stringify({ error: "message is required" }), { 
              status: 400, 
              headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
            });
          }

          if (!flow_id) {
            return new Response(JSON.stringify({ error: "flow_id is required" }), { 
              status: 400, 
              headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
            });
          }

          // Use the correct Langflow API endpoint: POST /api/v1/run/{flow_id}
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (LANGFLOW_API_KEY) {
            headers["Authorization"] = `Bearer ${LANGFLOW_API_KEY}`;
            headers["x-api-key"] = LANGFLOW_API_KEY;
          }

          // If streaming is requested, we pass through the stream mode
          if (streaming) {
            console.log(`Streaming chat request for flow: ${flow_id}`);
            
            try {
              // Create a new ReadableStream to manually control the data flow
              const { readable, writable } = new TransformStream();
              const writer = writable.getWriter();
              
                  // Function to send SSE formatted data
                  const sendSSE = async (data: any) => {
                    try {
                      const encoder = new TextEncoder();
                      
                      // If the data is a simple string or control message, send it as is
                      if (typeof data === 'string' || data.event === 'ping' || data.event === 'done' || data.event === 'error') {
                        const encodedData = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
                        await writer.write(encodedData);
                        return;
                      }
                      
                      // For complex responses, try to simplify before sending
                      // Look for nested text in the Langflow structure
                      if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
                        const output = data.outputs[0];
                        if (output.results && output.results.message && output.results.message.data && output.results.message.data.text) {
                          // Extract text for simpler client-side processing
                          const simplifiedData = {
                            text: output.results.message.data.text,
                            event: 'message'
                          };
                          const encodedData = encoder.encode(`data: ${JSON.stringify(simplifiedData)}\n\n`);
                          await writer.write(encodedData);
                          return;
                        }
                      }
                      
                      // Default case: send the original data
                      const encodedData = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
                      await writer.write(encodedData);
                    } catch (err) {
                      console.error("Error writing to stream:", err);
                    }
                  };              // Start a background process to handle the API call and streaming
              (async () => {
                try {
                  // Send initial message to keep the connection alive
                  await sendSSE({ event: "ping", message: "Connection established" });
                  
                  // Fetch with a longer timeout, but within the server's idle timeout
                  const res = await fetch(`${LANGFLOW_BASE}/api/v1/run/${flow_id}?stream=true`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ 
                      input_value: message,
                      input_type: "chat",
                      output_type: "chat"
                    }),
                    // Using AbortSignal for timeout control
                    signal: AbortSignal.timeout(250000) // 250 second timeout (just under the 255s server limit)
                  });
                  
                  console.log(`Streaming chat response status: ${res.status} ${res.statusText}`);
                  
                  if (!res.ok) {
                    await sendSSE({ 
                      event: "error", 
                      error: "Upstream API error",
                      status: res.status,
                      statusText: res.statusText
                    });
                    writer.close();
                    return;
                  }
                  
                  // Get the response body
                  const reader = res.body?.getReader();
                  if (!reader) {
                    throw new Error("Failed to get stream reader from API response");
                  }
                  
                  // Process the response stream
                  const decoder = new TextDecoder();
                  let buffer = '';
                  
                  // Debug info for the response
                  console.log(`Response status: ${res.status} ${res.statusText}`);
                  
                  // Send a diagnostic message to the client
                  await sendSSE({ 
                    event: "info", 
                    message: "Stream processing started" 
                  });
                  
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      
                      if (done) {
                        console.log("API stream complete");
                        break;
                      }
                      
                      // Decode the incoming chunk
                      const chunk = decoder.decode(value, { stream: true });
                      buffer += chunk;
                      
                      // Debug the raw chunk
                      console.log("Received chunk from API:", chunk.substring(0, 100) + (chunk.length > 100 ? "..." : ""));
                      
                      // Find complete SSE messages (data: ...\n\n)
                      let boundary;
                      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                        const message = buffer.substring(0, boundary);
                        buffer = buffer.substring(boundary + 2);
                        
                        // Process the message if it starts with "data: "
                        if (message.startsWith('data: ')) {
                          const dataStr = message.substring(6);
                          console.log("Processing SSE data:", dataStr.substring(0, 100) + (dataStr.length > 100 ? '...' : ''));
                          
                          try {
                            // Try to parse the data (could be JSON or plain text)
                            let parsedData;
                            try {
                              parsedData = JSON.parse(dataStr);
                            } catch (jsonError) {
                              // If it's not valid JSON, use the raw string
                              console.log("Non-JSON data received, treating as plain text");
                              const encoder = new TextEncoder();
                              await writer.write(encoder.encode(`data: ${JSON.stringify({text: dataStr})}\n\n`));
                              continue;
                            }
                            
                            // Process data differently based on its structure
                            let extractedText = "";
                            
                            // Handle Langflow's event:add_message format
                            if (parsedData.event === "add_message" && parsedData.data) {
                              if (parsedData.data.sender === "Machine" && parsedData.data.text) {
                                extractedText = parsedData.data.text;
                                console.log("Extracted text from add_message event:", extractedText.substring(0, 50) + "...");
                              }
                            } 
                            // Check for Langflow nested response format
                            else if (parsedData.outputs && Array.isArray(parsedData.outputs) && parsedData.outputs.length > 0) {
                              const output = parsedData.outputs[0];
                              if (output.results && output.results.message && output.results.message.data && output.results.message.data.text) {
                                extractedText = output.results.message.data.text;
                                console.log("Extracted text from nested response:", extractedText.substring(0, 50) + "...");
                              } 
                              // Try to find any useful fields
                              else {
                                console.log("No text found in nested structure, trying to find other fields");
                                
                                if (output.text) {
                                  extractedText = output.text;
                                } else if (output.message) {
                                  extractedText = typeof output.message === 'string' ? output.message : JSON.stringify(output.message);
                                } else if (output.value) {
                                  extractedText = typeof output.value === 'string' ? output.value : JSON.stringify(output.value);
                                }
                              }
                            }
                            // Simple text field
                            else if (parsedData.text) {
                              extractedText = parsedData.text;
                            }
                            // Event message with text
                            else if (parsedData.event === "message" && parsedData.text) {
                              extractedText = parsedData.text;
                            }
                            
                            // Send the extracted text to client
                            if (extractedText) {
                              const simplifiedData = {
                                text: extractedText,
                                event: 'message'
                              };
                              const encoder = new TextEncoder();
                              await writer.write(encoder.encode(`data: ${JSON.stringify(simplifiedData)}\n\n`));
                            } else {
                              // If we couldn't extract any text, just forward the original data
                              console.log("No outputs array found, checking for direct text field");
                              
                              // Forward the original message as a last resort
                              const encoder = new TextEncoder();
                              await writer.write(encoder.encode(`data: ${JSON.stringify(parsedData)}\n\n`));
                            }
                              
                              // Check for direct text field
                              if (parsedData.text) {
                                const simplifiedData = {
                                  text: parsedData.text,
                                  event: 'message'
                                };
                                
                                console.log("Found direct text field:", parsedData.text.substring(0, 50) + "...");
                                
                                // Send the simplified data
                                const encoder = new TextEncoder();
                                await writer.write(encoder.encode(`data: ${JSON.stringify(simplifiedData)}\n\n`));
                              } else {
                                // Forward the original message
                                const encoder = new TextEncoder();
                                await writer.write(encoder.encode(message + '\n\n'));
                              }
                          } catch (parseError) {
                            // If parsing fails, just forward the message as is
                            console.log("Failed to parse SSE data, forwarding as-is:", parseError);
                            const encoder = new TextEncoder();
                            await writer.write(encoder.encode(message + '\n\n'));
                          }
                        }
                      }
                    }
                    
                    // Send any remaining buffer content
                    if (buffer.length > 0 && buffer.startsWith('data: ')) {
                      const encoder = new TextEncoder();
                      await writer.write(encoder.encode(buffer + '\n\n'));
                    }
                    
                    // Send completion message
                    await sendSSE({ event: "done", message: "Stream complete" });
                    console.log("Sending stream completion signal");
                    await sendSSE("[DONE]");
                  } catch (streamError) {
                    console.error("Error processing API stream:", streamError);
                    await sendSSE({ 
                      event: "error", 
                      error: `Stream processing error: ${String(streamError)}`
                    });
                  } finally {
                    // Close the stream writer
                    writer.close().catch(err => {
                      console.error("Error closing stream writer:", err);
                    });
                  }
                } catch (fetchError) {
                  console.error("Fetch error:", fetchError);
                  await sendSSE({ 
                    event: "error", 
                    error: `Fetch error: ${String(fetchError)}`
                  });
                  writer.close().catch(err => {
                    console.error("Error closing stream writer:", err);
                  });
                }
              })().catch(err => {
                console.error("Fatal error in stream processing:", err);
              });
              
              // Return the readable stream immediately to the client
              return new Response(readable, { 
                headers: { 
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  ...corsHeaders(origin) 
                } 
              });
            } catch (error) {
              console.error("Streaming error:", error);
              return new Response(
                JSON.stringify({ error: "Streaming error", details: String(error) }), { 
                  status: 500, 
                  headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
                }
              );
            }
          } else {
            // Non-streaming request (original implementation)
            const res = await fetch(`${LANGFLOW_BASE}/api/v1/run/${flow_id}`, {
              method: "POST",
              headers,
              body: JSON.stringify({ 
                input_value: message,
                input_type: "chat",
                output_type: "chat"
              }),
            });
            
            console.log(`Chat response status: ${res.status} ${res.statusText}`);
            const text = await res.text();
            console.log(`Chat response body:`, text.substring(0, 500) + (text.length > 500 ? '...' : ''));
            
            // Try to parse the response as JSON to ensure it's properly formatted
            let responseBody = text;
            try {
              const jsonData = JSON.parse(text);
              
              // Ensure the output is consistently formatted
              if (jsonData && !jsonData.error) {
                // Format is already good, send it as is
                responseBody = JSON.stringify(jsonData);
              }
            } catch (e) {
              console.log("Response is not valid JSON, sending as text");
              // If it's not valid JSON, wrap it in a simple structure
              responseBody = JSON.stringify({
                outputs: [{
                  text: text
                }]
              });
            }
            
            return new Response(responseBody, { 
              status: res.status, 
              headers: { 
                "Content-Type": "application/json", 
                ...corsHeaders(origin) 
              } 
            });
          }
        }

        return new Response(JSON.stringify({ error: "Not found" }), { 
          status: 404, 
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) } 
        });
      } catch (err) {
        return new Response(JSON.stringify({ 
          error: "Proxy error", 
          details: String(err) 
        }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...corsHeaders(req.headers.get("origin")) } 
        });
      }
    },
  });

  console.log(`Proxy server running on http://localhost:${PORT}`);
}

main();

