import 'dotenv/config';
import path from 'path';
import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import appconfig from './src/appconfig';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'App Dev Wiki',
  tagline: 'Documentation, guides and technical resources for App Dev Club',
  favicon: appconfig.logo,

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: 'https://wiki.appdevclub.com',
  baseUrl: '/',

  organizationName: 'candiedoperation',
  projectName: 'TechOps',
  onBrokenLinks: 'throw',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [
    async function tailwindPlugin() {
      return {
        name: 'tailwind-plugin',
        configurePostCss(postcssOptions) {
          postcssOptions.plugins.push(require('@tailwindcss/postcss'));
          return postcssOptions;
        },
      };
    },

    async function aliasPlugin() {
      return {
        name: 'alias-plugin',
        configureWebpack() {
          return {
            resolve: {
              alias: {
                '@': path.resolve(__dirname, 'src'),
              },
            },
            devServer: {
              client: {
                overlay: false
              }
            }
          };
        },
      };
    },
  ],

  themes: ['@docusaurus/theme-mermaid'],
  markdown: { mermaid: true },
  clientModules: [
    require.resolve('./src/client-modules/theme-sync.ts'),
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/candiedoperation/TechOps/edit/master/corpwiki/',
        },

        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],


  themeConfig: {
    ...(process.env.ALGOLIA_API_KEY && process.env.ALGOLIA_APP_ID ? {
      algolia: {
        apiKey: process.env.ALGOLIA_API_KEY,
        indexName: "wiki_appdevclub_com_bn4x3t76rm_pages",
        appId: process.env.ALGOLIA_APP_ID,
        contextualSearch: false,
      },
    } : {}),

    image: 'img/wiki-preview-card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },

    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
