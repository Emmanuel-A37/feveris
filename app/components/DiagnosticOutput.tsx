import React from "react";
import ReactMarkdown from "react-markdown";

interface DiagnosticOutputProps {
  content: string;
}

const DiagnosticOutput: React.FC<DiagnosticOutputProps> = ({ content }) => (
  <div className="bg-green-950 border border-green-700 rounded-lg p-4 text-green-100 whitespace-pre-wrap font-mono text-sm">
    <ReactMarkdown>{content}</ReactMarkdown>
  </div>
);

export default DiagnosticOutput;
