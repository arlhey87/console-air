import React from "react";
import type { DocumentHeadTagsProps } from "@mui/material-nextjs/v14-pagesRouter";
import { documentGetInitialProps, DocumentHeadTags } from "@mui/material-nextjs/v14-pagesRouter";
import type { DocumentContext } from "next/document";
import { Head, Html, Main, NextScript } from "next/document";

import { withBasePath } from "@src/utils/basePath";
import { customColors } from "@src/utils/colors";

export default function MyDocument(props: DocumentHeadTagsProps) {
  return (
    <Html suppressHydrationWarning>
      <Head>
        {/* MUI */}
        <DocumentHeadTags {...props} />

        {/* PWA — public/ assets must be basePath-prefixed (Next won't do it for raw <link>) */}
        <link rel="shortcut icon" href={withBasePath("/favicon.ico")} />
        <link rel="manifest" href={withBasePath("/manifest.json")} crossOrigin="use-credentials" />
        <link rel="mask-icon" href={withBasePath("/safari-pinned-tab.svg")} color={customColors.dark} />
        <meta name="msapplication-TileColor" content={customColors.dark} />
        <link rel="apple-touch-icon" href={withBasePath("/apple-touch-icon.png")} />
        <meta name="theme-color" content={customColors.dark} />
        <link rel="icon" type="image/png" sizes="32x32" href={withBasePath("/favicon-32x32.png")} />
        <link rel="icon" type="image/png" sizes="16x16" href={withBasePath("/favicon-16x16.png")} />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100;300;500;700;900&display=swap" rel="stylesheet" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

MyDocument.getInitialProps = async (ctx: DocumentContext) => {
  const finalProps = await documentGetInitialProps(ctx);
  return finalProps;
};
