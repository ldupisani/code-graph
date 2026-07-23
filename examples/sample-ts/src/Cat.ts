import { Animal } from './Animal';

export class Cat extends Animal {
  makeSound(): string {
    return 'meow meow!';
  }

  somethingElse(): string {
    return 'else';
  }
}
