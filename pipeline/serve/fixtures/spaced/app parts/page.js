/**
 * Page script of the `spaced` fixture export: reads the global
 * `shared.js` set and writes it as visible text into the body.
 *
 * @packageDocumentation
 */

const greeting = document.createElement('p');
greeting.id = 'greeting';
greeting.textContent = window.rafaPortal.greeting;
document.body.appendChild(greeting);
