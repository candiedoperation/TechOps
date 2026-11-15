import React, { type ReactNode } from "react";
import type { WrapperProps } from "@docusaurus/types";
import type CodeBlockType from "@theme/CodeBlock";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockFilename,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockBody,
  CodeBlockItem,
  BundledLanguage,
} from "@/components/kibo-ui/code-block";

type Props = WrapperProps<typeof CodeBlockType>;

export default function CodeBlockWrapper(props: Props): ReactNode {
  const { children, className, title, language: propLanguage } = props;

  React.useEffect(() => {
    console.log(props);
  }, []);

  // Extract content
  // Docusaurus passes code content as children (string or array)
  const codeContent = (
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.join("")
        : ""
  ).trim();

  // Resolve Language
  // Docusaurus passes "language-xyz" in className, or sometimes a language prop
  let language = propLanguage;
  if (!language && className) {
    const match = className.match(/language-(\w+)/);
    if (match) language = match[1];
  }
  language = language || "text";

  // Resolve Filename/Title
  // If title is missing, we can default to language extension, but empty is cleaner if no title.
  // Kibo uses filename for icon detection.
  // If title is present, use it. If not, maybe use a dummy filename based on language to get the icon?
  // User asked for "file name can have mono text", implies using title as filename.
  const filename =
    (title ? String(title) : null) ||
    (language === "text" ? "Terminal" : `script.${language}`);

  // Create Data structure for Kibo
  // Note: Kibo uses 'language' as a unique key for tabs if we had multiple.
  // Since we have 1, we use its language.
  const data = [
    {
      language,
      filename,
      code: codeContent,
    },
  ];

  return (
    <CodeBlock value={language} data={data} className="my-6">
      <CodeBlockHeader>
        <CodeBlockFilename value={language}>
          {title || filename}
        </CodeBlockFilename>
        <div className="ml-auto">
          <CodeBlockCopyButton />
        </div>
      </CodeBlockHeader>
      <CodeBlockBody>
        {(data) => (
          <CodeBlockItem lineNumbers value={data.language} key={data.language}>
            <CodeBlockContent language={data.language as BundledLanguage}>
              {data.code}
            </CodeBlockContent>
          </CodeBlockItem>
        )}
      </CodeBlockBody>
    </CodeBlock>
  );
}
