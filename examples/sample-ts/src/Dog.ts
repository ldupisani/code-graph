import { Animal } from './Animal';
import { wagTail } from './util';

export class Dog extends Animal {
  makeSound(): string {
    return 'Woof..... Woof, Woof!';
  }

  greet(): string {
    wagTail(this.name);
    return this.describe();
  }
}
