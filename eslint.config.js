import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  // Không lint thư mục build, thư viện và file thử nghiệm của thành viên khác.
  globalIgnores(['dist', 'node_modules', 'test.html']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Layered Architecture: Firebase SDK chỉ được import trong src/infrastructure (nơi khởi tạo và các adapter).
  // (Domain/Application có khối riêng bên dưới và cũng cấm Firebase.)
  // Ngoại lệ TẠM THỜI, chỉ đúng một file: src/firebase.js là file Firebase legacy của nhánh dev (không được ứng dụng import).
  // Chờ nhóm quyết định chuyển vào src/infrastructure/ hoặc xóa; khi đó bỏ ngoại lệ này.
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/infrastructure/**', 'src/firebase.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['firebase', 'firebase/*', '@firebase/*'],
              message: 'Chỉ src/infrastructure được import Firebase SDK; các lớp khác dùng use case qua Application.',
            },
          ],
        },
      ],
    },
  },
  // Layered Architecture: Domain chỉ là JavaScript thuần, chỉ import từ chính Domain.
  // Mọi file domain nằm ở src/domain/<thư-mục>/*.js, nên "../../" trở lên là đã thoát khỏi Domain.
  {
    files: ['src/domain/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-router', 'react-router/*'],
              message: 'Domain không được import React/React Router.',
            },
            {
              group: ['firebase', 'firebase/*', '@firebase/*'],
              message: 'Domain không được import Firebase SDK (việc đó thuộc Infrastructure).',
            },
            {
              regex: '^(\\.\\./){2,}',
              message: 'Domain chỉ được import từ chính Domain, không import lớp khác.',
            },
            {
              regex: '(^|/)(presentation|application|infrastructure|app|services|contexts|utils)(/|$)',
              message: 'Domain không được phụ thuộc Presentation/Application/Infrastructure.',
            },
          ],
        },
      ],
    },
  },
  // Layered Architecture: Application chỉ được import Domain và chính Application.
  // Adapter (Firebase, MOCK...) được truyền vào qua tham số (Dependency Injection), không import.
  {
    files: ['src/application/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-router', 'react-router/*'],
              message: 'Application không được import React/React Router.',
            },
            {
              group: ['firebase', 'firebase/*', '@firebase/*'],
              message: 'Application không được import Firebase SDK (việc đó thuộc Infrastructure).',
            },
            {
              regex: '(^|/)(presentation|infrastructure|app|services|contexts|utils|firebase)(/|$)',
              message: 'Application không được phụ thuộc Presentation/Infrastructure/app.',
            },
            {
              // src/constants/* (hằng giao diện); hằng nghiệp vụ nằm ở domain/constants.
              regex: '^(\\.\\./)+constants/',
              message: 'Application chỉ dùng hằng nghiệp vụ từ domain/constants.',
            },
          ],
        },
      ],
    },
  },
  // Layered Architecture: Infrastructure cài các port của Application. Được import Domain và application/errors,
  // KHÔNG được phụ thuộc Presentation/app/React (Firebase SDK được phép, trừ adapter MOCK ở khối kế tiếp).
  {
    files: ['src/infrastructure/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-router', 'react-router/*'],
              message: 'Infrastructure không được import React/React Router.',
            },
            {
              regex: '^\\.{1,2}/(.*/)?(presentation|app|services|contexts|utils)(/|$)', // chỉ đường dẫn tương đối
              message: 'Infrastructure không được phụ thuộc Presentation/app/services.',
            },
          ],
        },
      ],
    },
  },
  // Adapter MOCK và các file không dính Firebase: cấm hẳn Firebase SDK và firebaseClient.
  {
    files: [
      'src/infrastructure/mock/**/*.{js,jsx}',
      'src/infrastructure/generateId.js',
      'src/infrastructure/createMockAdapters.js',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-router', 'react-router/*'],
              message: 'Infrastructure không được import React/React Router.',
            },
            {
              regex: '^\\.{1,2}/(.*/)?(presentation|app|services|contexts|utils)(/|$)', // chỉ đường dẫn tương đối
              message: 'Infrastructure không được phụ thuộc Presentation/app/services.',
            },
            {
              group: ['firebase', 'firebase/*', '@firebase/*'],
              message: 'Adapter MOCK không được import Firebase SDK.',
            },
            {
              regex: '(^|/)firebase(/|$)',
              message: 'Adapter MOCK không được import firebaseClient hay adapter Firebase.',
            },
          ],
        },
      ],
    },
  },
]);
