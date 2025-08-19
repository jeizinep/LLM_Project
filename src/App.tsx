import React, { useState, useEffect, useRef } from "react";
import { TextField, Button, Box, Typography, Paper, Select, MenuItem, FormControl, InputLabel } from "@mui/material";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Message {
  sender: "user" | "bot";
  text: string;
}

interface Flow {
  id: string;
  name: string;
  user_id?: string | null; // Added user_id property
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamingMessage, setStreamingMessage] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Helper function to update the bot message
  const updateBotMessage = (text: string | any) => {
    // If text is an array or object, handle it specially
    const processedText = typeof text === 'string' 
      ? text
      : (Array.isArray(text)
          ? text.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join("\n")
          : (typeof text === 'object' && text !== null
              ? JSON.stringify(text, null, 2)
              : String(text)));
    
    setStreamingMessage(processedText);
    setMessages(prev => {
      const newMessages = [...prev];
      if (newMessages.length > 0) {
        newMessages[newMessages.length - 1] = {
          sender: "bot",
          text: processedText
        };
      }
      return newMessages;
    });
  };
  
  // Helper function to extract text from various response formats
  const extractTextFromResponse = (data: any): string => {
    // Try different formats we might receive
    if (data.event === "token" && data.token) {
      return data.token;
    } else if (data.event === "message" && data.message) {
      return data.message;
    } else if (data.event === "add_message" && data.message) {
      return data.message;
    } else if (data.event === "end" && data.output) {
      return data.output;
    } else if (data.token) {
      return data.token;
    } else if (data.text) {
      return data.text;
    } else if (data.content) {
      return data.content;
    } else if (typeof data === 'string') {
      return data;
    }
    
    // Handle deeply nested Langflow response format
    if (data.results && data.results.message && data.results.message.data && data.results.message.data.text) {
      return data.results.message.data.text;
    }
    
    // Handle outputs array format
    if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
      const output = data.outputs[0];
      if (output.results && output.results.message && output.results.message.data && output.results.message.data.text) {
        return output.results.message.data.text;
      } else if (output.text) {
        return output.text;
      } else if (output.value) {
        return output.value;
      } else if (output.message) {
        return output.message;
      }
    }
    
    // If we can't find a recognized format but the data contains text somewhere
    const flattenedData = JSON.stringify(data);
    if (flattenedData.includes('"text":"') || flattenedData.includes('"content":"')) {
      console.log("Found text in nested structure");
      
      // Try to extract the text field from nested structure
      try {
        // Look for specific patterns in the response
        if (flattenedData.includes('"outputs":[{')) {
          const match = /"text":"([^"]+)"/.exec(flattenedData);
          if (match && match[1]) {
            return match[1].replace(/\\n/g, '\n');
          }
        }
      } catch (e) {
        console.error("Error extracting text from nested structure:", e);
      }
      
      // If we still can't extract, return a formatted JSON
      return `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
    }
    
    return "";
  };

  // Scroll to bottom of message list whenever messages change
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  
  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage]);

  useEffect(() => {
    const fetchFlows = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/flows");
        const data = await response.json();

        if (Array.isArray(data)) {
          const filteredFlows = data.filter((flow: Flow) => flow.user_id !== null && flow.user_id !== undefined && flow.user_id !== ""); // Exclude flows with user_id as null, undefined, or empty string
          setFlows(filteredFlows);
          setError("");
        } else {
          setError("Failed to fetch flows. Please check the API endpoint.");
          setFlows([]);
        }
      } catch (error) {
        setError("Failed to fetch flows. Please check your network connection.");
        setFlows([]);
      }
    };

    fetchFlows();
  }, []);

  // Process a streaming text chunk
  const processSseResponse = (eventData: string) => {
    try {
      // Check if it's the end marker
      if (eventData === "[DONE]") {
        console.log("Processing end of stream marker");
        return null;
      }
      
      // Try to parse as JSON
      try {
        const data = JSON.parse(eventData);
        
        // Check for known formats:
        
        // 1. Simple text field
        if (data.text) {
          return data.text;
        }
        
        // 2. Event format with text field
        if (data.event === 'message' && data.text) {
          return data.text;
        }
        
        // 3. Nested Langflow format
        if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
          const output = data.outputs[0];
          if (output.results && output.results.message && output.results.message.data && output.results.message.data.text) {
            return output.results.message.data.text;
          }
        }
        
        // 4. Event:add_message format
        if (data.event === 'add_message' && data.data && data.data.text) {
          return data.data.text;
        }
        
        // If we get here, we couldn't find any text
        console.log("Could not extract text from response data structure:", JSON.stringify(data).substring(0, 100) + "...");
        return null;
      } catch (e) {
        // If it's not valid JSON, just return as plain text
        // But filter out control messages
        if (
          eventData.includes('"event":"ping"') || 
          eventData.includes('"event":"info"') || 
          eventData.includes('"event":"done"')
        ) {
          return null;
        }
        
        return eventData;
      }
    } catch (err) {
      console.error("Error processing SSE response:", err);
      return null;
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !selectedFlow) return;

    const userMessage: Message = { sender: "user", text: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");

    // Create an empty bot message for streaming
    setIsStreaming(true);
    setStreamingMessage("");
    
    // Add a placeholder message for the bot that will be updated during streaming
    setMessages((prev) => [...prev, { sender: "bot", text: "" }]);
    
    const chatEndpoint = `http://localhost:3001/api/chat`;
    console.log("Using chat endpoint:", chatEndpoint);

      try {
        console.log("Sending message to chat endpoint with streaming:", {
          message: input,
          flow_id: selectedFlow,
          stream: true
        });

        // Let's use a simpler approach - first try with no streaming
        try {
          // First attempt: Get a full response without streaming
          console.log("Attempting non-streaming request first");        const response = await fetch(chatEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: input,
            flow_id: selectedFlow,
            stream: false // Explicitly disable streaming
          }),
          signal: AbortSignal.timeout(10000) // 10 second timeout for faster fallback to streaming
        });
        
        if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}`);
        }
        
        // Process the response
        const data = await response.json();
        console.log("Received non-streaming response:", data);
        
        // Extract the response and update the message
        if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
          const output = data.outputs[0];
          let responseText = "";
          
          // Handle Langflow nested response format
          if (output.results && output.results.message && output.results.message.data && output.results.message.data.text) {
            responseText = output.results.message.data.text;
          } 
          // Try various other formats
          else if (output.text) {
            responseText = output.text;
          }
          else if (output.value) {
            responseText = output.value;
          }
          else if (output.message) {
            responseText = output.message;
          }
          // Special case for artifacts.message format
          else if (output.artifacts && output.artifacts.message) {
            responseText = typeof output.artifacts.message === 'string' 
              ? output.artifacts.message 
              : JSON.stringify(output.artifacts.message);
          }
          // If still no text found, use the whole output
          else {
            responseText = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
          }
          
          updateBotMessage(responseText);
        } else if (data.event === "add_message" && data.data && data.data.text) {
          // Handle the Langflow message format
          updateBotMessage(data.data.text);
        } else {
          // If we can't extract text in a standard way, try to parse the response
          let responseText = "";
          
          if (typeof data === "string") {
            responseText = data;
          } else if (data.text) {
            responseText = data.text;
          } else if (data.content) {
            responseText = data.content;
          } else if (data.message) {
            responseText = data.message;
          } else {
            // Fallback: show the raw response as JSON
            responseText = "```json\n" + JSON.stringify(data, null, 2) + "\n```";
          }
          
          updateBotMessage(responseText);
        }
      } catch (error) {
        console.error("Error with non-streaming request:", error);
        
        // Add a "thinking" effect with dots to simulate streaming for user experience
        const thinkingDots = [".", "..", "..."];
        let dotIndex = 0;
        
        // Start the thinking animation
        const thinkingInterval = setInterval(() => {
          updateBotMessage(`*Thinking${thinkingDots[dotIndex]}*`);
          dotIndex = (dotIndex + 1) % thinkingDots.length;
        }, 500);
        
        try {
          // Second attempt: Use EventSource for proper SSE handling
          console.log("Falling back to streaming request");
          
          // Stop the thinking animation
          clearInterval(thinkingInterval);
          
          console.log("Using EventSource for streaming");
          
          // Create an EventSource connection
          const eventSource = new EventSource(
            `${chatEndpoint}?message=${encodeURIComponent(input)}&flow_id=${selectedFlow}&stream=true`
          );
          
          let hasReceivedContent = false;
          
          let accumulatedText = '';
          
          eventSource.onmessage = (event) => {
            console.log("Streaming response received:", event.data.substring(0, 100) + (event.data.length > 100 ? "..." : ""));
            
            try {
              // Check for the end signal
              if (event.data === "[DONE]") {
                console.log("Stream complete");
                eventSource.close();
                return;
              }
              
              const result = processSseResponse(event.data);
              if (result) {
                // Accumulate the text and show incremental updates for real-time streaming effect
                accumulatedText += result;
                updateBotMessage(accumulatedText);
                hasReceivedContent = true;
              }
            } catch (err) {
              console.error("Error parsing streaming response:", err);
            }
          };
          
          eventSource.onerror = (err) => {
            console.error("EventSource error:", err);
            eventSource.close();
            
            if (!hasReceivedContent) {
              updateBotMessage("Error receiving streaming response. Please try again.");
            }
          };
          
          // Handle the stream end manually
          setTimeout(() => {
            if (!hasReceivedContent) {
              console.log("No content received from SSE, checking for text in buffer");
              
              // Try to extract text from the raw response using a manual fetch
              fetch(`${chatEndpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  message: input,
                  flow_id: selectedFlow,
                  stream: false
                })
              })
              .then(res => res.json())
              .then(data => {
                // Try to extract the text content
                const extractedText = extractTextFromResponse(data);
                if (extractedText) {
                  console.log("Found text in fallback response:", extractedText.substring(0, 50) + "...");
                  updateBotMessage(extractedText);
                } else {
                  updateBotMessage("Received a response but couldn't extract any text content.");
                }
                eventSource.close();
              })
              .catch(err => {
                console.error("Error with fallback request:", err);
                eventSource.close();
              });
            } else {
              eventSource.close();
            }
          }, 15000); // 15 second fallback
        } catch (streamErr) {
          console.error("Error with alternative request method:", streamErr);
          
          // Stop the thinking animation
          clearInterval(thinkingInterval);
          
          // Display an appropriate error message
          const errMessage = streamErr instanceof Error ? streamErr.message : String(streamErr);
          updateBotMessage(`*Sorry, I couldn't generate a response. Please try again later.*\n\nError: ${errMessage}`);
        }
      }
      
      // Set streaming to false when we're done
      setIsStreaming(false);
    } catch (error) {
      console.error("Error sending message:", error);
      // Remove the empty placeholder message on error
      setMessages(prev => prev.slice(0, -1));
      setIsStreaming(false);
    }
  };

  return (
    <Box p={4}>
      {error && (
        <Typography color="error" style={{ marginBottom: "16px" }}>
          {error}
        </Typography>
      )}

      <FormControl fullWidth margin="normal">
        <InputLabel>Select Flow</InputLabel>
        <Select
          value={selectedFlow}
          onChange={(e) => setSelectedFlow(e.target.value)}
          disabled={!!error}
        >
          {flows.map((flow) => (
            <MenuItem key={flow.id} value={flow.id}>
              {flow.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Paper
        elevation={3}
        style={{ padding: "16px", maxHeight: "600px", overflowY: "auto", marginTop: "16px" }}
      >
        {messages.map((msg, index) => (
          <Box
            key={index}
            sx={{
              textAlign: msg.sender === "user" ? "right" : "left",
              margin: "12px 0",
              padding: "8px 12px",
              backgroundColor: msg.sender === "user" ? "rgba(25, 118, 210, 0.08)" : "rgba(0, 0, 0, 0.05)",
              borderRadius: "8px",
              maxWidth: "80%",
              marginLeft: msg.sender === "user" ? "auto" : "0",
              marginRight: msg.sender === "user" ? "0" : "auto",
            }}
          >
            <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
              {msg.sender === "user" ? "You" : "Bot"}
            </Typography>
            
            {msg.sender === "user" ? (
              <Typography>{msg.text}</Typography>
            ) : (
              <Box 
                className="markdown-content"
                sx={{ 
                  "& pre": { 
                    borderRadius: "6px",
                    overflowX: "auto",
                    margin: "0.5em 0"
                  },
                  "& :not(pre) > code": { 
                    fontFamily: "monospace",
                    fontSize: "0.875em",
                    padding: "2px 4px",
                    backgroundColor: "rgba(0,0,0,0.2)",
                    borderRadius: "4px",
                    color: "#e6e6e6"
                  },
                  "& blockquote": {
                    borderLeft: "4px solid #ccc",
                    paddingLeft: "16px",
                    margin: "8px 0"
                  },
                  "& img": {
                    maxWidth: "100%"
                  },
                  "& table": {
                    borderCollapse: "collapse",
                    width: "100%",
                    marginBottom: "16px"
                  },
                  "& th, & td": {
                    border: "1px solid #ccc",
                    padding: "8px",
                    textAlign: "left"
                  },
                  "& a": {
                    color: "#1976d2",
                    textDecoration: "underline"
                  },
                  "& h1": {
                    fontSize: "1.8em",
                    borderBottom: "1px solid #ddd",
                    paddingBottom: "0.3em",
                    marginTop: "1em",
                    marginBottom: "0.5em"
                  },
                  "& h2": {
                    fontSize: "1.5em",
                    borderBottom: "1px solid #eee",
                    paddingBottom: "0.3em",
                    marginTop: "1em",
                    marginBottom: "0.5em"
                  },
                  "& h3": {
                    fontSize: "1.3em",
                    marginTop: "1em",
                    marginBottom: "0.5em"
                  },
                  "& ul, & ol": {
                    paddingLeft: "2em",
                    marginBottom: "1em"
                  },
                  "& li": {
                    margin: "0.3em 0"
                  },
                  "& hr": {
                    height: "0.25em",
                    padding: "0",
                    margin: "24px 0",
                    backgroundColor: "#e1e4e8",
                    border: "0"
                  },
                  "& p": {
                    marginTop: "0.5em",
                    marginBottom: "0.5em"
                  }
                }}
              >
                <ReactMarkdown
                  rehypePlugins={[rehypeSanitize]}
                  components={{
                    code: ({className, children, ...props}) => {
                      // @ts-ignore - inline property is used by react-markdown internally
                      const isInline = props.inline;
                      const match = /language-(\w+)/.exec(className || '');
                      return !isInline && match ? (
                        <SyntaxHighlighter
                          // @ts-ignore - type issues with the style prop and language
                          language={match[1]}
                          // @ts-ignore - type issues with the style prop
                          style={vscDarkPlus}
                          PreTag="div"
                          {...props}
                        >
                          {String(children).replace(/\n$/, '')}
                        </SyntaxHighlighter>
                      ) : (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    }
                  }}
                >
                  {msg.text}
                </ReactMarkdown>
                {isStreaming && index === messages.length - 1 && (
                  <Box sx={{ display: 'flex', alignItems: 'center', marginTop: '8px' }}>
                    <span className="cursor-blink" style={{ 
                      display: 'inline-block',
                      width: '8px',
                      height: '16px',
                      backgroundColor: '#1976d2',
                      marginRight: '8px',
                      animation: 'blink 1s step-end infinite'
                    }}>|</span>
                    <Typography variant="caption" color="textSecondary">
                      Generating response...
                    </Typography>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        ))}
        <div ref={messagesEndRef} />
      </Paper>

      <Box mt={2} display="flex" gap={2}>
        <TextField
          fullWidth
          variant="outlined"
          placeholder="Type your message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!!error || isStreaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isStreaming && selectedFlow && !error) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <Button
          variant="contained"
          color="primary"
          onClick={sendMessage}
          disabled={!selectedFlow || !!error || isStreaming}
        >
          {isStreaming ? "Processing..." : "Send"}
        </Button>
      </Box>
    </Box>
  );
}

export default App;
