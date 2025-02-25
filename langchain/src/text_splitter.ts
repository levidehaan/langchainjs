import type * as tiktoken from "js-tiktoken";
import { Document } from "./document.js";
import { getEncoding } from "./util/tiktoken.js";

export interface TextSplitterParams {
  chunkSize: number;
  chunkOverlap: number;
}

export type TextSplitterChunkHeaderOptions = {
  chunkHeader?: string;
  chunkOverlapHeader?: string;
  appendChunkOverlapHeader?: boolean;
};

export abstract class TextSplitter implements TextSplitterParams {
  chunkSize = 1000;

  chunkOverlap = 200;

  constructor(fields?: Partial<TextSplitterParams>) {
    this.chunkSize = fields?.chunkSize ?? this.chunkSize;
    this.chunkOverlap = fields?.chunkOverlap ?? this.chunkOverlap;
    if (this.chunkOverlap >= this.chunkSize) {
      throw new Error("Cannot have chunkOverlap >= chunkSize");
    }
  }

  abstract splitText(text: string): Promise<string[]>;

  async createDocuments(
    texts: string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadatas: Record<string, any>[] = [],
    chunkHeaderOptions: TextSplitterChunkHeaderOptions = {}
  ): Promise<Document[]> {
    // if no metadata is provided, we create an empty one for each text
    const _metadatas =
      metadatas.length > 0 ? metadatas : new Array(texts.length).fill({});
    const {
      chunkHeader = "",
      chunkOverlapHeader = "(cont'd) ",
      appendChunkOverlapHeader = false,
    } = chunkHeaderOptions;
    const documents = new Array<Document>();
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      let lineCounterIndex = 1;
      let prevChunk = null;
      for (const chunk of await this.splitText(text)) {
        let pageContent = chunkHeader;

        // we need to count the \n that are in the text before getting removed by the splitting
        let numberOfIntermediateNewLines = 0;
        if (prevChunk) {
          const indexChunk = text.indexOf(chunk);
          const indexEndPrevChunk = text.indexOf(prevChunk) + prevChunk.length;
          const removedNewlinesFromSplittingText = text.slice(
            indexEndPrevChunk,
            indexChunk
          );
          numberOfIntermediateNewLines = (
            removedNewlinesFromSplittingText.match(/\n/g) || []
          ).length;
          if (appendChunkOverlapHeader) {
            pageContent += chunkOverlapHeader;
          }
        }
        lineCounterIndex += numberOfIntermediateNewLines;
        const newLinesCount = (chunk.match(/\n/g) || []).length;

        const loc =
          _metadatas[i].loc && typeof _metadatas[i].loc === "object"
            ? { ..._metadatas[i].loc }
            : {};
        loc.lines = {
          from: lineCounterIndex,
          to: lineCounterIndex + newLinesCount,
        };
        const metadataWithLinesNumber = {
          ..._metadatas[i],
          loc,
        };

        pageContent += chunk;
        documents.push(
          new Document({
            pageContent,
            metadata: metadataWithLinesNumber,
          })
        );
        lineCounterIndex += newLinesCount;
        prevChunk = chunk;
      }
    }
    return documents;
  }

  async splitDocuments(
    documents: Document[],
    chunkHeaderOptions: TextSplitterChunkHeaderOptions = {}
  ): Promise<Document[]> {
    const selectedDocuments = documents.filter(
      (doc) => doc.pageContent !== undefined
    );
    const texts = selectedDocuments.map((doc) => doc.pageContent);
    const metadatas = selectedDocuments.map((doc) => doc.metadata);
    return this.createDocuments(texts, metadatas, chunkHeaderOptions);
  }

  private joinDocs(docs: string[], separator: string): string | null {
    const text = docs.join(separator).trim();
    return text === "" ? null : text;
  }

  mergeSplits(splits: string[], separator: string): string[] {
    const docs: string[] = [];
    const currentDoc: string[] = [];
    let total = 0;
    for (const d of splits) {
      const _len = d.length;
      if (
        total + _len + (currentDoc.length > 0 ? separator.length : 0) >
        this.chunkSize
      ) {
        if (total > this.chunkSize) {
          console.warn(
            `Created a chunk of size ${total}, +
which is longer than the specified ${this.chunkSize}`
          );
        }
        if (currentDoc.length > 0) {
          const doc = this.joinDocs(currentDoc, separator);
          if (doc !== null) {
            docs.push(doc);
          }
          // Keep on popping if:
          // - we have a larger chunk than in the chunk overlap
          // - or if we still have any chunks and the length is long
          while (
            total > this.chunkOverlap ||
            (total + _len > this.chunkSize && total > 0)
          ) {
            total -= currentDoc[0].length;
            currentDoc.shift();
          }
        }
      }
      currentDoc.push(d);
      total += _len;
    }
    const doc = this.joinDocs(currentDoc, separator);
    if (doc !== null) {
      docs.push(doc);
    }
    return docs;
  }
}

export interface CharacterTextSplitterParams extends TextSplitterParams {
  separator: string;
}

export class CharacterTextSplitter
  extends TextSplitter
  implements CharacterTextSplitterParams
{
  separator = "\n\n";

  constructor(fields?: Partial<CharacterTextSplitterParams>) {
    super(fields);
    this.separator = fields?.separator ?? this.separator;
  }

  async splitText(text: string): Promise<string[]> {
    // First we naively split the large input into a bunch of smaller ones.
    let splits: string[];
    if (this.separator) {
      splits = text.split(this.separator);
    } else {
      splits = text.split("");
    }
    return this.mergeSplits(splits, this.separator);
  }
}

export interface RecursiveCharacterTextSplitterParams
  extends TextSplitterParams {
  separators: string[];
}

export class RecursiveCharacterTextSplitter
  extends TextSplitter
  implements RecursiveCharacterTextSplitterParams
{
  separators: string[] = ["\n\n", "\n", " ", ""];

  constructor(fields?: Partial<RecursiveCharacterTextSplitterParams>) {
    super(fields);
    this.separators = fields?.separators ?? this.separators;
  }

  async splitText(text: string): Promise<string[]> {
    const finalChunks: string[] = [];

    // Get appropriate separator to use
    let separator: string = this.separators[this.separators.length - 1];
    for (const s of this.separators) {
      if (s === "") {
        separator = s;
        break;
      }
      if (text.includes(s)) {
        separator = s;
        break;
      }
    }

    // Now that we have the separator, split the text
    let splits: string[];
    if (separator) {
      splits = text.split(separator);
    } else {
      splits = text.split("");
    }

    // Now go merging things, recursively splitting longer texts.
    let goodSplits: string[] = [];
    for (const s of splits) {
      if (s.length < this.chunkSize) {
        goodSplits.push(s);
      } else {
        if (goodSplits.length) {
          const mergedText = this.mergeSplits(goodSplits, separator);
          finalChunks.push(...mergedText);
          goodSplits = [];
        }
        const otherInfo = await this.splitText(s);
        finalChunks.push(...otherInfo);
      }
    }
    if (goodSplits.length) {
      const mergedText = this.mergeSplits(goodSplits, separator);
      finalChunks.push(...mergedText);
    }
    return finalChunks;
  }
}

export interface TokenTextSplitterParams extends TextSplitterParams {
  encodingName: tiktoken.TiktokenEncoding;
  allowedSpecial: "all" | Array<string>;
  disallowedSpecial: "all" | Array<string>;
}

/**
 * Implementation of splitter which looks at tokens.
 */
export class TokenTextSplitter
  extends TextSplitter
  implements TokenTextSplitterParams
{
  encodingName: tiktoken.TiktokenEncoding;

  allowedSpecial: "all" | Array<string>;

  disallowedSpecial: "all" | Array<string>;

  private tokenizer: tiktoken.Tiktoken;

  constructor(fields?: Partial<TokenTextSplitterParams>) {
    super(fields);

    this.encodingName = fields?.encodingName ?? "gpt2";
    this.allowedSpecial = fields?.allowedSpecial ?? [];
    this.disallowedSpecial = fields?.disallowedSpecial ?? "all";
  }

  async splitText(text: string): Promise<string[]> {
    if (!this.tokenizer) {
      this.tokenizer = await getEncoding(this.encodingName);
    }

    const splits: string[] = [];

    const input_ids = this.tokenizer.encode(
      text,
      this.allowedSpecial,
      this.disallowedSpecial
    );

    let start_idx = 0;
    let cur_idx = Math.min(start_idx + this.chunkSize, input_ids.length);
    let chunk_ids = input_ids.slice(start_idx, cur_idx);

    while (start_idx < input_ids.length) {
      splits.push(this.tokenizer.decode(chunk_ids));

      start_idx += this.chunkSize - this.chunkOverlap;
      cur_idx = Math.min(start_idx + this.chunkSize, input_ids.length);
      chunk_ids = input_ids.slice(start_idx, cur_idx);
    }

    return splits;
  }
}

export type MarkdownTextSplitterParams = TextSplitterParams;

export class MarkdownTextSplitter
  extends RecursiveCharacterTextSplitter
  implements MarkdownTextSplitterParams
{
  separators: string[] = [
    // First, try to split along Markdown headings (starting with level 2)
    "\n## ",
    "\n### ",
    "\n#### ",
    "\n##### ",
    "\n###### ",
    // Note the alternative syntax for headings (below) is not handled here
    // Heading level 2
    // ---------------
    // End of code block
    "```\n\n",
    // Horizontal lines
    "\n\n***\n\n",
    "\n\n---\n\n",
    "\n\n___\n\n",
    // Note that this splitter doesn't handle horizontal lines defined
    // by *three or more* of ***, ---, or ___, but this is not handled
    "\n\n",
    "\n",
    " ",
    "",
  ];

  constructor(fields?: Partial<MarkdownTextSplitterParams>) {
    super(fields);
  }
}
