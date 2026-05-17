import { Dog } from './Dog';
import { Cat } from './Cat';
import { purr } from './util';

const buddy = new Dog('Buddy');
const whiskers = new Cat('Whiskers');

console.log(buddy.greet());
console.log(whiskers.describe());
purr(whiskers.name);
